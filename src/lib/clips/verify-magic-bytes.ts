// ============================================================================
// ClipsFlow Clips — magic-byte verification for user-supplied uploads
// ============================================================================
// Verifies that uploaded files actually match their declared MIME type by
// checking the first bytes against known magic signatures. SVG is rejected
// outright (text-based, unreliable magic bytes, potential XSS via <script>).
//
// Ported from VidiaFlow src/lib/clipflow/verify-magic-bytes.ts.
// EXTENDED : adds audio magic bytes —
//   - MP3 : ID3 header ("49 44 33") or MPEG frame sync (0xFF 0xEx / 0xFF 0xFx)
//   - M4A : same ftyp box as MP4 (ISOBMFF), accepted as audio/mp4 + audio/x-m4a
//   - WAV : "RIFF????WAVE" — offset 0 = RIFF, offset 8 = WAVE
// EXTENDED (Lot 3) : pure byte-level sniff for DOWNLOADED clip sources —
//   `verifySourceMagicBytes(bytes, contentType?)`. The storage-based
//   `verifyMagicBytes` above needs a bucket+path ; the render pipeline
//   (run-job.ts) has the source on /tmp and only needs a header check, so
//   this entry point takes the first bytes directly. No I/O, no ffmpeg
//   import — stays unit-testable.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type SupportedAssetMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "font/woff2"
  | "audio/mpeg"
  | "audio/mp4"
  | "audio/x-m4a"
  | "audio/wav";

/** Magic byte signatures for the file types we accept. */
const MAGIC_SIGNATURES: Record<
  SupportedAssetMime,
  ReadonlyArray<{ offset: number; bytes: ReadonlyArray<number> }>
> = {
  // PNG : 0x89 50 4E 47 0D 0A 1A 0A
  "image/png": [
    {
      offset: 0,
      bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    },
  ],
  // JPEG : starts with 0xFFD8FF — third byte varies (E0 = JFIF, E1 = EXIF,
  // DB = raw, etc) so we only assert the first 3.
  "image/jpeg": [
    {
      offset: 0,
      bytes: [0xff, 0xd8, 0xff],
    },
  ],
  // WebP : "RIFF????WEBP" — offset 0 = R I F F, offset 8 = W E B P.
  "image/webp": [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // WEBP
  ],
  // WOFF2 : 0x77 4F 46 32 ("wOF2")
  "font/woff2": [
    {
      offset: 0,
      bytes: [0x77, 0x4f, 0x46, 0x32],
    },
  ],
  // MP3 : starts with ID3 tag ("ID3" = 0x49 0x44 0x33) or with an
  // MPEG audio frame sync (0xFF followed by 0xEx or 0xFx — the high
  // nibble of the second byte is always 0xE or 0xF for all MPEG
  // frame headers). We check the ID3 prefix first (most common).
  // A second candidate signature covers raw MPEG frames without ID3.
  "audio/mpeg": [
    // ID3 header : "ID3"
    { offset: 0, bytes: [0x49, 0x44, 0x33] },
  ],
  // M4A / audio-only MPEG-4 : uses the same ISOBMFF ftyp box as MP4.
  // We accept both "ftyp" (standard) and common M4A brands by checking
  // the box-type offset alone (identical to verifyMp4MagicBytes logic).
  "audio/mp4": [
    // bytes 4-7 = "ftyp" (0x66 0x74 0x79 0x70)
    { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  ],
  "audio/x-m4a": [
    // Same ftyp box — identical to audio/mp4
    { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  ],
  // WAV : "RIFF????WAVE" — offset 0 = R I F F, offset 8 = W A V E.
  // We assert BOTH boundaries to avoid false positives with other
  // RIFF-family containers (AVI, WebP also uses RIFF).
  "audio/wav": [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
    { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] }, // WAVE
  ],
};

/**
 * Minimum bytes needed for the most-stringent check. WAV needs 12 bytes
 * (offset 8 + 4-byte chunk). Always grab a few extra for a stable window.
 */
const PROBE_BYTES = 16;

interface VerifyParams {
  supabase: SupabaseClient;
  bucket: string;
  path: string;
  declaredMime: string;
}

interface VerifyResult {
  ok: boolean;
  reason?:
    | "unsupported_mime"
    | "magic_mismatch"
    | "download_failed"
    | "empty_body";
  detectedMime?: SupportedAssetMime;
}

/**
 * Download the first `PROBE_BYTES` of the uploaded asset and verify the
 * magic signature against the declared MIME. Returns `ok: true` only when
 * every signature offset matches.
 *
 * On failure the caller is expected to (a) delete the uploaded object from
 * storage and (b) refuse to persist the URL. This lib stays pure — no side
 * effects on storage.
 */
export async function verifyMagicBytes(
  params: VerifyParams,
): Promise<VerifyResult> {
  const declared = params.declaredMime as SupportedAssetMime;
  if (!(declared in MAGIC_SIGNATURES)) {
    return { ok: false, reason: "unsupported_mime" };
  }

  const { data, error } = await params.supabase.storage
    .from(params.bucket)
    .download(params.path);

  if (error || !data) {
    return { ok: false, reason: "download_failed" };
  }

  const buffer = await data.arrayBuffer();
  if (buffer.byteLength === 0) {
    return { ok: false, reason: "empty_body" };
  }

  const bytes = new Uint8Array(buffer.slice(0, PROBE_BYTES));
  const signatures = MAGIC_SIGNATURES[declared];

  // For audio/mpeg we also accept MPEG frame sync (0xFF + high nibble 0xE/0xF)
  // as an alternative to the ID3 check — checked separately below.
  if (declared === "audio/mpeg") {
    // Check ID3 path via primary signatures array first.
    const id3Match =
      bytes.byteLength >= 3 &&
      bytes[0] === 0x49 &&
      bytes[1] === 0x44 &&
      bytes[2] === 0x33;
    // MPEG frame sync : 0xFF and second byte high nibble ≥ 0xE.
    const frameSyncMatch =
      bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
    if (!id3Match && !frameSyncMatch) {
      return { ok: false, reason: "magic_mismatch" };
    }
    return { ok: true, detectedMime: declared };
  }

  for (const sig of signatures) {
    if (bytes.byteLength < sig.offset + sig.bytes.length) {
      return { ok: false, reason: "magic_mismatch" };
    }
    for (let i = 0; i < sig.bytes.length; i++) {
      if (bytes[sig.offset + i] !== sig.bytes[i]) {
        return { ok: false, reason: "magic_mismatch" };
      }
    }
  }

  return { ok: true, detectedMime: declared };
}

// ============================================================================
// Lot 3 — pure byte-level sniff for downloaded clip SOURCES (run-job.ts)
// ============================================================================

/**
 * Media container families the clips pipeline accepts as a source :
 *   - isobmff : MP4 / MOV / M4A (box-structured MPEG-4 container)
 *   - webm    : WebM / Matroska (EBML header)
 *   - mp3     : MPEG audio (ID3 tag or raw frame sync)
 *   - wav     : RIFF/WAVE
 */
export type SourceMediaFamily = "isobmff" | "webm" | "mp3" | "wav";

/**
 * Maps a normalized content-type (no parameters, lowercased) to the
 * container family its bytes must exhibit. Types absent from this map
 * (e.g. `application/octet-stream`, generic CDN defaults) impose no
 * family constraint — any recognized family passes.
 */
const CONTENT_TYPE_FAMILY: Record<string, SourceMediaFamily> = {
  "video/mp4": "isobmff",
  "video/quicktime": "isobmff",
  "audio/mp4": "isobmff",
  "audio/x-m4a": "isobmff",
  "audio/m4a": "isobmff",
  "video/webm": "webm",
  "audio/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

/**
 * ISOBMFF box types accepted at offset 4. `ftyp` / `styp` cover every
 * modern MP4/MOV/M4A (same set as `verifyMp4MagicBytes` in mp4-probe.ts) ;
 * the rest are legacy QuickTime openers (`moov`-first files predating the
 * ftyp convention, `wide`/`free`/`skip` padding atoms, `pnot` previews).
 */
const ISOBMFF_BOX_TYPES = new Set([
  "ftyp",
  "styp",
  "moov",
  "mdat",
  "free",
  "skip",
  "wide",
  "pnot",
]);

/**
 * Detects the container family from the first bytes of a media file
 * (16 bytes suffice for every signature below). Returns `null` when no
 * known family matches. Pure — never throws.
 */
export function detectSourceMediaFamily(
  bytes: Uint8Array,
): SourceMediaFamily | null {
  // ISOBMFF (mp4 / mov / m4a) : 4-char box type at offset 4.
  if (bytes.byteLength >= 8) {
    const box = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
    if (ISOBMFF_BOX_TYPES.has(box)) return "isobmff";
  }
  // EBML (webm / mkv) : 0x1A 0x45 0xDF 0xA3 at offset 0.
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "webm";
  }
  // WAV before MP3 — "RIFF????WAVE" is stricter than the loose MPEG
  // frame-sync rule, so test it first.
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  ) {
    return "wav";
  }
  // MP3 : ID3 tag…
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    return "mp3";
  }
  // …or raw MPEG frame sync (0xFF + high nibble 0xE/0xF on byte 2).
  if (
    bytes.byteLength >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xe0) === 0xe0
  ) {
    return "mp3";
  }
  return null;
}

export interface VerifySourceResult {
  ok: boolean;
  /** Detected family (set even on content-type mismatch, for logging). */
  family: SourceMediaFamily | null;
}

/**
 * Verifies the first bytes of a downloaded clip source against the known
 * media families. When `contentType` is provided (HTTP response header)
 * AND maps to a known family, the detected family must match it ;
 * otherwise any recognized family passes.
 *
 * Pure — the caller (run-job.ts) reads the bytes from /tmp and decides
 * what to throw (`invalid_source_file:`).
 */
export function verifySourceMagicBytes(
  bytes: Uint8Array,
  contentType?: string | null,
): VerifySourceResult {
  const family = detectSourceMediaFamily(bytes);
  if (!family) return { ok: false, family: null };

  if (contentType) {
    // Strip parameters ("video/mp4; charset=binary" → "video/mp4").
    const base = contentType.split(";")[0]!.trim().toLowerCase();
    const expected = CONTENT_TYPE_FAMILY[base];
    if (expected && expected !== family) {
      return { ok: false, family };
    }
  }

  return { ok: true, family };
}
