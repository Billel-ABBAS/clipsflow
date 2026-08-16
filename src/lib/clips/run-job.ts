// ============================================================================
// ClipsFlow Clips async pipeline — runRenderJob
// ============================================================================
// Drives the Whisper + ffmpeg + libass burn pipeline for a single CLAIMED
// `jobs` row of type='render'. The cron worker (Lot 3) claims the job,
// calls this function, and owns the final row UPDATEs.
//
// Pre-conditions :
//   - jobs row exists with status='processing' (caller has already claimed
//     it via claim-job.ts)
//   - job.type === 'render' and job.clip_id (or payload.clip_id) points to
//     a clips row whose parent episode carries a reachable source
//
// Post-conditions :
//   - mp4 (+ best-effort vtt) uploaded to the `clip-outputs` bucket at
//     `{user_id}/{clip_id}.mp4` / `.vtt`
//   - signed 24h download URLs returned in RunRenderJobResult
//   - quota was already reserved at submit time (clips_reserve_quota) —
//     this function does NOT touch quota ; the cron error handler refunds
//     via `refundClipSeconds` on failure
//
// The function does NOT update the `clips` / `jobs` rows itself
// (status='completed', video_url, etc.). The caller (cron worker) is
// responsible for that final UPDATE — keeps the cron in charge of the
// lifecycle (status transitions live in one place).
//
// Errors are thrown with a descriptive prefix so the caller can stamp the
// failure on the row and route refunds :
//   - invalid_job:            wrong job type / missing clip_id / owner mismatch
//   - clip_not_found:         clips row missing
//   - invalid_clip_status:    clip already completed/failed (no re-render)
//   - episode_not_found:      parent episodes row missing
//   - invalid_source_url:     SSRF-blocked or absent source
//   - source_download_failed: HTTP error / empty body / sign failure
//   - source_too_large:       source exceeds the 500 MB cap
//   - invalid_source_file:    magic-byte sniff failed (not a recognized
//                             media container, or bytes contradict the
//                             response content-type). Refundable like any
//                             other post-reservation failure.
//   - segment_too_long:       clip window exceeds 180 s
//   - segment_extract_failed: probe or ffmpeg segment extraction failed
//   - whisper_failed:         transcription API failure
//   - no_speech_detected:     Whisper returned 0 words
//   - translation_*:          rethrown verbatim from translate-cues
//   - audiogram_failed:       audiogram base render failed (audio sources)
//   - subtitle_burn_failed:   ffmpeg burn failure (wraps inner errors,
//                             incl. brand_kit_logo_unavailable:)
//   - upload_failed:          mp4 upload or signing failure
// VTT failures are caught and logged-not-thrown (best-effort — the clip
// still ships if the sidecar upload fails).
//
// Ported from VidiaFlow src/lib/clipflow/run-job.ts (runSubtitleJob).
// Structural adaptations vs source :
//   - Loads `clips` + parent `episodes` rows (source received the fully-
//     formed clip_subtitle_jobs row) ; source resolution handles BOTH
//     https source_url and storage-path-signed sources.
//   - NEW : segment extraction BEFORE transcription. Podcast episodes run
//     2-3 h ; Whisper caps ~25 MB. The [start_seconds, end_seconds]
//     window is cut to a /tmp segment (video mp4 OR audio m4a) and THAT
//     is what Whisper + the burn consume. Whisper timestamps are segment-
//     relative (0-based) and the burn runs with startSec=0 — no re-offset.
//   - NEW : audio-only branch — `renderAudiogramBase()` synthesises the
//     video track, then the standard burn draws captions on it.
//   - REMOVED : brand-kit reload (no brand_kits table), LUT / plan-tier
//     gating (enableLut3d), classifier dispatch, video_id, resolution
//     tiers (mono-1080p), poster extraction (null in P1), llm_usage_logs
//     whisper telemetry insert + WHISPER_USD_PER_SECOND pricing table
//     (table absent in P1), disclosure audit table write (TODO(P2) below).
// ============================================================================

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFetch } from "@/lib/utils/safe-fetch";
import {
  validateOutboundUrl,
  defaultClipsAllowedHosts,
  OutboundUrlError,
} from "@/lib/security/validate-outbound-url";
import type { ClipJob, QueueJob } from "./types";
import type { OverlayElement } from "./overlays";
import { verifySourceMagicBytes } from "./verify-magic-bytes";

// ----------------------------------------------------------------------------
// Minimal structured logger. VidiaFlow used `@/lib/observability/logger` ;
// ClipsFlow has no observability module yet, so this shim keeps the call
// sites identical to the source (drop-in replacement target for a future
// logger module). Output goes to platform logs as single-line JSON.
// ----------------------------------------------------------------------------
const logger = {
  info(message: string, ctx: Record<string, unknown> = {}): void {
    console.log(
      JSON.stringify({
        level: "info",
        source: "clips-run-job",
        message,
        ...ctx,
      }),
    );
  },
  warn(message: string, ctx: Record<string, unknown> = {}): void {
    console.warn(
      JSON.stringify({
        level: "warn",
        source: "clips-run-job",
        message,
        ...ctx,
      }),
    );
  },
  error(message: string, ctx: Record<string, unknown> = {}): void {
    console.error(
      JSON.stringify({
        level: "error",
        source: "clips-run-job",
        message,
        ...ctx,
      }),
    );
  },
};

/**
 * Sentry capture helper for the clips burn pipeline. Fail-soft : if the
 * Sentry capture itself throws (SDK not initialised — the ClipsFlow SDK is
 * a runtime no-op until configured — network blip, regression), we swallow
 * the secondary error so it never cascades. The caller's `logger.error` +
 * thrown error continue propagating.
 */
function captureRunJobError(
  err: unknown,
  job: QueueJob,
  clip: ClipJob | null,
  step: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    const errMsg = (err as Error)?.message ?? String(err);
    const errorPrefix = errMsg.split(":")[0];
    Sentry.captureException(err, {
      tags: {
        feature: "clips",
        run_job_step: step,
        job_id: job.id,
        user_id: job.user_id,
        error_prefix: errorPrefix,
      },
      extra: {
        error_message: errMsg.slice(0, 400),
        clip_id: clip?.id ?? job.clip_id ?? null,
        style_key: clip?.style_key ?? null,
        aspect_ratio: clip?.aspect_ratio ?? null,
        duration_seconds: clip ? clip.end_seconds - clip.start_seconds : null,
        language: clip?.language ?? null,
        ...extra,
      },
    });
  } catch {
    // Sentry capture itself failed — don't cascade.
  }
}

/**
 * Sentry breadcrumb helper for the clips pipeline. Each pipeline stage
 * emits an `entry` breadcrumb (start) and a matching `complete` breadcrumb
 * with relevant metrics (word count, byte count, cue count). When a
 * downstream error fires `captureRunJobError`, the breadcrumb trail on the
 * Sentry event shows EXACTLY which stage failed + key metrics at that point.
 *
 * Privacy : we NEVER log source URLs, full filenames with user paths,
 * tokens, transcript content, or any user PII. Only structural counts
 * (word count, byte count) and pipeline state.
 *
 * Fail-soft : `Sentry.addBreadcrumb` is best-effort. If the SDK is absent
 * (test env, not initialised), the call is a no-op. Wrapped in try/catch
 * as defence in depth in case a future SDK regression makes it throw.
 */
function addPipelineBreadcrumb(
  message: string,
  level: "info" | "warning" = "info",
  data?: Record<string, unknown>,
): void {
  try {
    Sentry.addBreadcrumb({
      category: "clips.pipeline",
      message,
      level,
      data,
    });
  } catch {
    // breadcrumb add itself failed — don't cascade.
  }
}

/**
 * Hard cap on source media size for the clips pipeline. Serverless /tmp =
 * 512 MB per invocation ; we leave a margin for the extracted segment, the
 * rendered MP4 output, and staged fonts. Sources above this throw
 * `source_too_large:` (refunded by the cron handler like any other failure).
 */
const MAX_SOURCE_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Hard cap on the clip window. Whisper handles ≤180 s segments comfortably
 * within its ~25 MB upload cap at AAC 128k, and short-form clips have no
 * business being longer.
 */
const MAX_SEGMENT_SECONDS = 180;

export interface RunRenderJobResult {
  video_url: string; // signed URL 24h
  video_storage_path: string; // clip-outputs/{user_id}/{clip_id}.mp4
  captions_vtt_url: string | null;
  captions_vtt_storage_path: string | null;
  thumbnail_url: string | null; // null in P1 (poster removed like the source post-2026-05-08)
  thumbnail_storage_path: string | null; // null in P1
  cost_usd: number;
  score: number | null; // hook score 0-100
  hook_text: string | null; // first sentence of the clip transcript
  detected_language: string | null;
}

/** Minimal episode row shape consumed by the render pipeline. */
type EpisodeSourceRow = {
  id: string;
  user_id: string;
  source_type: "upload" | "url";
  source_url: string | null;
  source_storage_path: string | null;
  status: string;
};

/**
 * Spawn ffmpeg to cut the [startSec, endSec] window out of the source into
 * a standalone /tmp segment. Two shapes :
 *   - video : H.264 ultrafast CRF 18 re-encode (frame-accurate cut — a
 *     stream-copy cut lands on keyframes and desyncs A/V on long-GOP
 *     podcast video) + AAC audio so the downstream burn `-c:a copy` is
 *     container-legal whatever the source codec was.
 *   - audio : `-vn` + AAC 128k in an .m4a (MP4 container — Whisper accepts
 *     it under the same `source.mp4` File name used by whisper.ts).
 *
 * Throws `segment_extract_failed:` on non-zero ffmpeg exit.
 */
async function extractSegment(opts: {
  sourcePath: string;
  startSec: number;
  endSec: number;
  hasVideo: boolean;
  outPath: string;
}): Promise<void> {
  const ffmpegPath = (await import("@ffmpeg-installer/ffmpeg")).default;
  const common = [
    "-ss",
    opts.startSec.toFixed(2),
    "-to",
    opts.endSec.toFixed(2),
    "-i",
    opts.sourcePath,
    "-sn",
    "-dn",
  ];
  const args = opts.hasVideo
    ? [
        ...common,
        // 0:V:0 (V majuscule) = premier VRAI flux vidéo — exclut les
        // cover-art "attached pic" des mp3/m4a podcast (review lot 2).
        "-map",
        "0:V:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        // CRF 18 = visually near-lossless intermediate. The burn encodes
        // again at CRF 18-22 ; keeping the intermediate tight avoids
        // visible generation loss.
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-y",
        opts.outPath,
      ]
    : [...common, "-vn", "-c:a", "aac", "-b:a", "128k", "-y", opts.outPath];

  await new Promise<void>((res, rej) => {
    const p = spawn(ffmpegPath.path, args);
    let stderrBuf = "";
    p.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });
    p.on("error", rej);
    p.on("close", (code) => {
      if (code === 0) res();
      else
        rej(
          new Error(
            `ffmpeg segment extract exited ${code}: ${stderrBuf.slice(-600)}`,
          ),
        );
    });
  });
}

/**
 * Drive the segment-extract + whisper + ffmpeg burn pipeline for a CLAIMED
 * render job (status='processing', claimed_at set). Throws on any pipeline
 * error so the caller (cron worker) can mark the rows 'failed' + refund.
 *
 * @param supabase  Service-role admin client. Used for the clips/episodes
 *                  loads, storage uploads and signed URL creation.
 * @param job       The claimed `jobs` row. type='render',
 *                  payload={clip_id}. All clip inputs (start/end, style,
 *                  aspect, customizations, overlays, language) are read
 *                  from the referenced `clips` row.
 */
export async function runRenderJob(
  supabase: SupabaseClient,
  job: QueueJob,
): Promise<RunRenderJobResult> {
  // Lazy imports — keep ffmpeg + Whisper + libass off the module load
  // path so the cron worker boots fast. Same pattern as the VidiaFlow
  // source (the heavy native modules inflate cold-start when pulled in
  // at the top level).
  const { transcribeWithWhisper } = await import("./whisper");
  // PNG overlay spike (CPU-only) — feature flag opts the cron worker
  // into the 2-pass libass-pre-render → libx264-overlay path. Default
  // OFF so production keeps the proven single-pass libass-during-encode
  // pipeline. See `src/lib/clips/subtitle-burn-png-overlay.ts`.
  const usePngOverlay = process.env.CLIPS_BURN_PNG_OVERLAY === "1";
  const { burnSubtitles } = await import("./subtitle-burn");
  const { burnSubtitlesViaPngOverlay } = usePngOverlay
    ? await import("./subtitle-burn-png-overlay")
    : { burnSubtitlesViaPngOverlay: null };

  // ── Step 0 — Load + validate the clip and its parent episode ─────────
  const payloadClipId =
    typeof job.payload?.clip_id === "string" ? job.payload.clip_id : null;
  const clipId = job.clip_id ?? payloadClipId;
  if (job.type !== "render" || !clipId) {
    throw new Error(
      `invalid_job: expected type='render' with a clip_id (got type='${job.type}', clip_id=${clipId ?? "null"})`,
    );
  }

  const { data: clipRow } = await supabase
    .from("clips")
    .select("*")
    .eq("id", clipId)
    .single();
  if (!clipRow) {
    throw new Error(`clip_not_found: clips row ${clipId} missing`);
  }
  const clip = clipRow as ClipJob;
  // Defence in depth : the job row must belong to the clip's owner. The
  // service-role client bypasses RLS, so an explicit ownership check at
  // the call site keeps a forged/corrupt jobs row from rendering someone
  // else's clip.
  if (clip.user_id !== job.user_id) {
    throw new Error(`invalid_job: job.user_id does not own clip ${clipId}`);
  }
  // Status guard : pending/processing are renderable (the cron claims the
  // job first, then flips the clip row — both orders are tolerated).
  // completed/failed are terminal — a re-render would double-bill quota.
  if (clip.status === "completed" || clip.status === "failed") {
    throw new Error(
      `invalid_clip_status: clip ${clipId} is '${clip.status}' — refusing to re-render a terminal clip`,
    );
  }

  const { data: episodeRow } = await supabase
    .from("episodes")
    .select("id, user_id, source_type, source_url, source_storage_path, status")
    .eq("id", clip.episode_id)
    .eq("user_id", clip.user_id) // defence in depth (RLS bypassed by service role)
    .single();
  if (!episodeRow) {
    throw new Error(
      `episode_not_found: episodes row ${clip.episode_id} missing for clip ${clipId}`,
    );
  }
  const episode = episodeRow as EpisodeSourceRow;

  const segmentDuration = clip.end_seconds - clip.start_seconds;
  const durationSeconds = Math.max(1, Math.floor(segmentDuration));

  // OBS — pipeline entry breadcrumb. Sets the start of the trail visible
  // on every Sentry event captured downstream.
  addPipelineBreadcrumb("pipeline_start", "info", {
    job_id: job.id,
    clip_id: clip.id,
    style_key: clip.style_key,
    aspect_ratio: clip.aspect_ratio,
    duration_seconds: durationSeconds,
    language: clip.language,
    source_type: episode.source_type,
  });

  // Hard bound on the clip window BEFORE any download / extraction work.
  if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) {
    throw new Error(
      `segment_extract_failed: non-positive clip window [${clip.start_seconds}, ${clip.end_seconds}]`,
    );
  }
  if (segmentDuration > MAX_SEGMENT_SECONDS) {
    throw new Error(
      `segment_too_long: clip window is ${segmentDuration}s (limit ${MAX_SEGMENT_SECONDS}s). Pick a shorter segment.`,
    );
  }

  // ── Step 1 — Resolve the source URL ──────────────────────────────────
  // Two shapes :
  //   (a) episode.source_url — external https URL (podcast RSS enclosure,
  //       direct link). Re-validated through the SSRF guard WITHOUT a host
  //       allowlist (any public https host is legitimate here) — private
  //       ranges / metadata endpoints / non-https all still throw.
  //   (b) episode.source_storage_path — user upload in `clip-sources` ;
  //       sign a 1 h read URL with the service-role client, then validate
  //       it against the Supabase allowlist (defence in depth).
  let sourceUrl: string;
  let sourceAllowedHosts: string[] | undefined;
  try {
    if (episode.source_url) {
      validateOutboundUrl(episode.source_url);
      sourceUrl = episode.source_url;
      sourceAllowedHosts = undefined;
    } else if (episode.source_storage_path) {
      const { data: signed, error: signErr } = await supabase.storage
        .from("clip-sources")
        .createSignedUrl(episode.source_storage_path, 3600);
      if (signErr || !signed?.signedUrl) {
        throw new Error(
          `source_download_failed: could not sign source storage path (${signErr?.message ?? "no URL returned"})`,
        );
      }
      sourceAllowedHosts = defaultClipsAllowedHosts();
      validateOutboundUrl(signed.signedUrl, {
        allowedHosts: sourceAllowedHosts,
      });
      sourceUrl = signed.signedUrl;
    } else {
      throw new Error(
        `invalid_source_url: episode ${episode.id} has neither source_url nor source_storage_path`,
      );
    }
  } catch (err) {
    if (err instanceof OutboundUrlError) {
      logger.error("clip source URL blocked by SSRF guard", {
        job_id: job.id,
        clip_id: clip.id,
        reason: err.message,
      });
      captureRunJobError(err, job, clip, "ssrf_guard", {
        outbound_reason: err.message,
      });
      throw new Error(`invalid_source_url: ${err.message}`);
    }
    captureRunJobError(err, job, clip, "ssrf_guard");
    throw err;
  }

  // ── Step 2 — Stream the source to /tmp ───────────────────────────────
  // Stream the response body straight to /tmp instead of buffering the
  // whole media into RAM via arrayBuffer(). A 2-3 h podcast source can
  // be hundreds of MB ; streaming to disk caps per-job memory at
  // ~50-100 MB regardless of source size.
  const sourcePath = join(
    tmpdir(),
    `clips-source-${job.id}-${randomUUID()}.media`,
  );
  // OBS — source download stage entry. We DO NOT log the source URL
  // itself (presigned tokens, potential PII in path segments) ; the
  // hostname alone is enough to spot CDN-class issues.
  let sourceHost = "unknown";
  try {
    sourceHost = new URL(sourceUrl).hostname;
  } catch {
    // malformed URL would have been caught by validateOutboundUrl above
  }
  addPipelineBreadcrumb("source_download_start", "info", {
    source_host: sourceHost,
  });
  // Captured for the magic-byte sniff below (Step 2.5) — when the upstream
  // declares a known media content-type, the downloaded bytes must match it.
  let sourceContentType: string | null = null;
  try {
    // 30 s timeout. Supabase Storage P95 < 5 s ; CDN edge cases (user's
    // source on a slow/dead host) capped here so the worker doesn't hang
    // up to maxDuration on a stuck chunk read. FetchTimeoutError bubbles
    // up as `source_download_failed: …` so the cron stuck-recovery +
    // quota refund path handles it like any other download failure.
    const sourceRes = await safeFetch(sourceUrl, {
      timeoutMs: 30_000,
      allowedHosts: sourceAllowedHosts,
    });
    if (!sourceRes.ok) {
      throw new Error(
        `source_download_failed: HTTP ${sourceRes.status} ${sourceRes.statusText}`,
      );
    }
    // Defence-in-depth size check — content-length header lets us bail
    // BEFORE streaming bytes. Some upstreams omit it (chunked encoding) ;
    // the cumulative-byte counter below catches those.
    const contentLengthHeader = sourceRes.headers.get("content-length");
    const contentLength = contentLengthHeader
      ? parseInt(contentLengthHeader, 10)
      : 0;
    if (contentLength > MAX_SOURCE_BYTES) {
      throw new Error(
        `source_too_large: Source media is ${Math.round(contentLength / 1024 / 1024)} MB ` +
          `(limit ${MAX_SOURCE_BYTES / 1024 / 1024} MB). Try a lower bitrate or shorter source.`,
      );
    }
    if (!sourceRes.body) {
      throw new Error("source_download_failed: response has no body");
    }
    sourceContentType = sourceRes.headers.get("content-type");
    // Stream to disk. The cumulative byte counter aborts the stream if
    // the upstream lies about content-length (or omits it entirely). We
    // use Readable.fromWeb on the WHATWG ReadableStream then pipe into
    // a Node WritableStream — single-pass, no intermediate buffering.
    let totalBytes = 0;
    let abortedTooLarge = false;
    const nodeStream = Readable.fromWeb(
      sourceRes.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    nodeStream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_SOURCE_BYTES) {
        abortedTooLarge = true;
        nodeStream.destroy(
          new Error(
            `source_too_large: Source media exceeded ${MAX_SOURCE_BYTES / 1024 / 1024} MB ` +
              `during streaming (chunked encoding hid the true size). ` +
              `Try a lower bitrate or shorter source.`,
          ),
        );
      }
    });
    const fileStream = createWriteStream(sourcePath);
    try {
      await pipeline(nodeStream, fileStream);
    } catch (pipelineErr) {
      // Surface the cumulative-byte abort as a clean `source_too_large:`
      // instead of the generic pipeline rejection. Other errors bubble up.
      if (abortedTooLarge) {
        throw new Error(
          `source_too_large: Source media exceeded ${MAX_SOURCE_BYTES / 1024 / 1024} MB.`,
        );
      }
      throw pipelineErr;
    }
    // Verify the stream actually produced bytes — a 200 response with an
    // empty body would otherwise sail through and crash ffmpeg later
    // with a cryptic decoder error.
    const stats = await stat(sourcePath);
    if (stats.size === 0) {
      throw new Error(
        "source_download_failed: downloaded 0 bytes from source URL",
      );
    }
    // OBS — exit breadcrumb with size confirmation.
    addPipelineBreadcrumb("source_download_complete", "info", {
      bytes_received: stats.size,
    });
  } catch (err) {
    // Cleanup on any error before re-throwing — keeps /tmp clean even
    // on the failure path. /tmp persists across warm invocations, so a
    // leaked source here pollutes the next job.
    await unlink(sourcePath).catch(() => {});
    const errMsg = (err as Error).message;
    logger.error("source download failed", {
      job_id: job.id,
      clip_id: clip.id,
      error: errMsg,
    });
    captureRunJobError(err, job, clip, "source_download");
    // Preserve typed prefixes so the cron handler refund/UI mapping
    // sees the right error class. `source_too_large:` and
    // `source_download_failed:` both already start with their prefix —
    // don't double-wrap them.
    if (
      errMsg.startsWith("source_too_large:") ||
      errMsg.startsWith("source_download_failed:")
    ) {
      throw err;
    }
    throw new Error(`source_download_failed: ${errMsg.slice(0, 400)}`);
  }

  // From this point on, the rest of the pipeline must run inside a
  // try/finally so we always unlink every /tmp artifact on exit (success
  // or throw). See the bottom-of-function `finally` block.
  let segmentPath: string | null = null;
  let audiogramPath: string | null = null;
  try {
    // ── Step 2.5 — Magic-byte sniff of the downloaded source (Lot 3) ───
    // Cheap 16-byte header check BEFORE handing the file to ffmpeg : a
    // text/HTML error page (expired signed URL, CDN soft-404) or a
    // mislabeled non-media file would otherwise surface as a cryptic
    // ffmpeg decoder error deep in the probe/extract steps. The expected
    // family is deduced from the response content-type when the upstream
    // sent a recognized one ; otherwise any supported media family
    // (ISOBMFF mp4/mov/m4a, WebM, MP3, WAV) passes. Failure throws
    // `invalid_source_file:` — a fresh-job post-reservation failure,
    // refunded by the cron handler (NOT in REFUND_EXCLUDED_PREFIXES).
    {
      const probeBuf = Buffer.alloc(16);
      let probeBytesRead = 0;
      const fh = await open(sourcePath, "r");
      try {
        const { bytesRead } = await fh.read(probeBuf, 0, 16, 0);
        probeBytesRead = bytesRead;
      } finally {
        await fh.close();
      }
      const magic = verifySourceMagicBytes(
        probeBuf.subarray(0, probeBytesRead),
        sourceContentType,
      );
      if (!magic.ok) {
        logger.error("source magic-byte verification failed", {
          job_id: job.id,
          clip_id: clip.id,
          detected_family: magic.family,
          content_type: sourceContentType,
        });
        throw new Error(
          `invalid_source_file: source bytes are not a supported media container ` +
            `(detected family: ${magic.family ?? "none"}, ` +
            `content-type: ${sourceContentType ?? "absent"})`,
        );
      }
    }

    // ── Step 3 — Probe the source for a real video track ───────────────
    // Decides the segment shape (video mp4 vs audio m4a) AND the burn
    // branch (standard vs audiogram). Embedded podcast cover art
    // ("attached pic" streams) is NOT a video track — probeHasVideoStream
    // excludes it.
    let hasVideo: boolean;
    try {
      const { probeHasVideoStream } = await import("./mp4-probe");
      hasVideo = await probeHasVideoStream(sourcePath);
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error("source probe failed", {
        job_id: job.id,
        clip_id: clip.id,
        error: errMsg.slice(0, 400),
      });
      captureRunJobError(err, job, clip, "source_probe");
      throw new Error(
        `segment_extract_failed: probe failed — ${errMsg.slice(0, 300)}`,
      );
    }

    // ── Step 4 — Extract the [start, end] segment to its own /tmp file ─
    // THIS segment (not the full source) feeds Whisper + the burn. Video
    // segments are re-encoded (frame-accurate cut + AAC audio) ; audio
    // segments land as a light .m4a.
    segmentPath = join(
      tmpdir(),
      `clips-segment-${job.id}-${randomUUID()}.${hasVideo ? "mp4" : "m4a"}`,
    );
    addPipelineBreadcrumb("segment_extract_start", "info", {
      has_video: hasVideo,
      start_seconds: clip.start_seconds,
      end_seconds: clip.end_seconds,
      duration_seconds: durationSeconds,
    });
    try {
      await extractSegment({
        sourcePath,
        startSec: clip.start_seconds,
        endSec: clip.end_seconds,
        hasVideo,
        outPath: segmentPath,
      });
      const segStats = await stat(segmentPath);
      if (segStats.size === 0) {
        throw new Error("extracted segment is 0 bytes");
      }
      addPipelineBreadcrumb("segment_extract_complete", "info", {
        segment_bytes: segStats.size,
        has_video: hasVideo,
      });
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error("segment extraction failed", {
        job_id: job.id,
        clip_id: clip.id,
        error: errMsg.slice(0, 400),
      });
      captureRunJobError(err, job, clip, "segment_extract", {
        has_video: hasVideo,
      });
      if (errMsg.startsWith("segment_extract_failed:")) {
        throw err;
      }
      throw new Error(`segment_extract_failed: ${errMsg.slice(0, 400)}`);
    }

    // ── Step 5 — Whisper transcript of the SEGMENT (auto-detect lang) ──
    // Timestamps come back relative to the segment (0-based) — exactly
    // what the burn expects since it runs with startSec=0. No re-offset.
    addPipelineBreadcrumb("whisper_transcribe_start", "info", {
      duration_seconds: durationSeconds,
    });
    let words: import("./whisper").WordTimestamp[];
    let detectedLanguage: string;
    try {
      const result = await transcribeWithWhisper(
        sourceUrl, // label only — sourcePath takes precedence below
        undefined,
        undefined,
        segmentPath,
      );
      words = result.words;
      detectedLanguage = result.detectedLanguage;
      logger.info("whisper transcription done", {
        job_id: job.id,
        clip_id: clip.id,
        detected_language: detectedLanguage,
        word_count: words.length,
        model: result.model,
        latency_ms: result.latencyMs,
      });
      // OBS — Whisper exit breadcrumb. Word count + detected language
      // are the most useful diagnostic signals at this stage (no
      // transcript content — PII risk).
      addPipelineBreadcrumb("whisper_transcribe_complete", "info", {
        word_count: words.length,
        detected_language: detectedLanguage,
        model: result.model,
        latency_ms: result.latencyMs,
      });
      // NOTE : the VidiaFlow source fire-and-forgot an `llm_usage_logs`
      // insert here (whisper audio-seconds cost telemetry). ClipsFlow P1
      // has no llm_usage_logs table — the per-clip estimate returned in
      // `cost_usd` (computeClipCost) already includes the Whisper share.
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error("whisper transcription failed", {
        job_id: job.id,
        clip_id: clip.id,
        error: errMsg,
      });
      captureRunJobError(err, job, clip, "whisper_transcription");
      throw new Error(`whisper_failed: ${errMsg.slice(0, 400)}`);
    }

    // Step 5.5 — Empty-words guard. Whisper returns `words=[]` for
    // sources with no detectable speech (music-only tracks, silent
    // footage, or audio in a language Whisper couldn't pick up). Without
    // this guard the burn pipeline falls back to a `null` ffmpeg filter
    // and produces a CLEAN mp4 with no subtitles (silent no-op). The cron
    // worker would then stamp `status='completed'` and the user gets a
    // clip with no subs while their quota is consumed. We fail loudly
    // here so the cron handler can refund quota + surface a user-friendly
    // error in the gallery.
    if (words.length === 0) {
      throw new Error(
        "no_speech_detected: Whisper returned 0 words. Source likely has no detectable speech (music-only, silent track, or unsupported audio language).",
      );
    }

    // ── Step 6 — Translate cues when source language ≠ target ──────────
    // Map user-supplied BCP-47 code to Whisper full-name convention.
    // Whisper auto-detect returns the English language name lowercased ;
    // we keep the same convention so the `detectedLanguage !==
    // targetLangName` check below works.
    const langNameMap: Record<string, string> = {
      fr: "french",
      en: "english",
      es: "spanish",
      "pt-BR": "portuguese",
      de: "german",
      it: "italian",
      nl: "dutch",
      tr: "turkish",
      ja: "japanese",
      ko: "korean",
      ar: "arabic",
      "zh-CN": "chinese",
      ru: "russian",
      hi: "hindi",
      pl: "polish",
      ro: "romanian",
      sv: "swedish",
      cs: "czech",
      el: "greek",
      hu: "hungarian",
      fi: "finnish",
      da: "danish",
      no: "norwegian",
      he: "hebrew",
      th: "thai",
      vi: "vietnamese",
      id: "indonesian",
      ms: "malay",
      sw: "swahili",
      uk: "ukrainian",
    };
    // `"auto"` sentinel (set by the submit route when the caller omits
    // `language`) means "keep the detected source language ; no
    // translation". Aligns `targetLangName` with `detectedLanguage` so
    // the conditional below short-circuits cleanly.
    const targetLangName =
      clip.language === "auto"
        ? detectedLanguage
        : (langNameMap[clip.language] ?? clip.language);

    let preTranslatedCues:
      | { text: string; start: number; end: number }[]
      | undefined;

    if (detectedLanguage !== targetLangName && words.length > 0) {
      // OBS — translate stage entry breadcrumb.
      addPipelineBreadcrumb("translate_start", "info", {
        from_language: detectedLanguage,
        to_language: targetLangName,
        word_count: words.length,
      });
      try {
        const { translateCues } = await import("./translate-cues");
        preTranslatedCues = await translateCues(
          words,
          detectedLanguage,
          targetLangName,
        );
        logger.info("subtitle translation done", {
          job_id: job.id,
          clip_id: clip.id,
          from: detectedLanguage,
          to: targetLangName,
          cue_count: preTranslatedCues.length,
        });
        // OBS — translate stage exit breadcrumb.
        addPipelineBreadcrumb("translate_complete", "info", {
          cue_count: preTranslatedCues.length,
          from_language: detectedLanguage,
          to_language: targetLangName,
        });
      } catch (err) {
        const errMsg = (err as Error).message;
        // A silent fall-through here would be a high-severity silent
        // fail — the user picked a target language and would get
        // source-language captions with no error signal. translate-cues
        // throws `translation_partial:` / `translation_empty_cue:` /
        // `translation_unsupported_language:` ; rethrow so the cron
        // worker error handler can refund quota and stamp the row as
        // failed. Any unrelated catch (e.g. dynamic import failure) is
        // also surfaced — silent fallback is not acceptable here.
        logger.error("subtitle translation failed", {
          job_id: job.id,
          clip_id: clip.id,
          from: detectedLanguage,
          to: targetLangName,
          error: errMsg.slice(0, 400),
        });
        captureRunJobError(err, job, clip, "translation", {
          from_language: detectedLanguage,
          to_language: targetLangName,
        });
        throw err;
      }
    }

    // ── Step 6bis — Audiogram base for audio-only sources ──────────────
    // Synthesises the dark-background + waveform video at the target
    // aspect. The standard burn then draws captions on it exactly like a
    // video segment (identity crop since the canvas is already at the
    // canonical dims). renderAudiogramBase throws `audiogram_failed:` —
    // already prefixed, rethrown untouched.
    let burnInputPath = segmentPath;
    if (!hasVideo) {
      addPipelineBreadcrumb("audiogram_start", "info", {
        aspect_ratio: clip.aspect_ratio,
        duration_seconds: durationSeconds,
      });
      try {
        const { renderAudiogramBase } = await import("./render-audiogram");
        audiogramPath = await renderAudiogramBase(
          segmentPath,
          clip.aspect_ratio,
          segmentDuration,
        );
        burnInputPath = audiogramPath;
        addPipelineBreadcrumb("audiogram_complete", "info", {
          aspect_ratio: clip.aspect_ratio,
        });
      } catch (err) {
        logger.error("audiogram base render failed", {
          job_id: job.id,
          clip_id: clip.id,
          error: (err as Error).message.slice(0, 400),
        });
        captureRunJobError(err, job, clip, "audiogram");
        throw err; // already `audiogram_failed:`-prefixed
      }
    }

    // ── Step 7 — ffmpeg subtitle burn ───────────────────────────────────
    // User-supplied overlays (clips.overlays) are composited on top of
    // the caption track in the order they were supplied. (The VidiaFlow
    // brand-kit logo auto-injection is removed — no brand kits in P1.)
    const overlays: OverlayElement[] = Array.isArray(clip.overlays)
      ? clip.overlays
      : [];

    // Pre-allocate the output paths up-front. Deterministic per clip
    // (contract : clip-outputs/{user_id}/{clip_id}.mp4) — uploads use
    // upsert so a retried job overwrites its own partial artifacts.
    const outPath = `${clip.user_id}/${clip.id}.mp4`;
    const vttStoragePath = `${clip.user_id}/${clip.id}.vtt`;

    let renderedBuf: Buffer;
    let captionsVtt: string;
    // OBS — ffmpeg burn stage entry breadcrumb.
    addPipelineBreadcrumb("ffmpeg_burn_start", "info", {
      png_overlay_path: usePngOverlay,
      overlay_count: overlays.length,
      aspect_ratio: clip.aspect_ratio,
      audiogram_input: !hasVideo,
    });
    try {
      const burnFn =
        usePngOverlay && burnSubtitlesViaPngOverlay
          ? burnSubtitlesViaPngOverlay
          : burnSubtitles;
      if (usePngOverlay) {
        logger.info("clips burn path = png-overlay (spike)", {
          job_id: job.id,
          clip_id: clip.id,
        });
      }

      // Smart-crop saliency analysis runs ONLY for real video sources
      // when the target aspect differs from a typical 16:9 long-form
      // frame — i.e. the ffmpeg filter would otherwise center-crop a
      // vertical or square window out of a horizontal source. The
      // audiogram canvas is generated at the target dims, so saliency
      // would be wasted compute there.
      let smartCropOffset: number | null = null;
      if (hasVideo && clip.aspect_ratio && clip.aspect_ratio !== "16:9") {
        try {
          const { computeSmartCropOffset } = await import("./smart-crop");
          smartCropOffset = await computeSmartCropOffset(burnInputPath);
          logger.info("clips smart-crop offset", {
            job_id: job.id,
            clip_id: clip.id,
            offset: smartCropOffset,
            target_ratio: clip.aspect_ratio,
          });
        } catch (err) {
          // Saliency failure is non-fatal — burn falls back to centered
          // crop. Log and move on.
          logger.warn("smart-crop analysis failed (falling back to center)", {
            job_id: job.id,
            clip_id: clip.id,
            error: (err as Error).message,
          });
        }
      }
      const burnResult = await burnFn({
        sourceVideoUrl: sourceUrl,
        sourcePath: burnInputPath, // disk-backed segment, no RAM buffer
        words,
        preTranslatedCues,
        styleKey: clip.style_key,
        // The segment IS the clip window — Whisper timestamps are
        // segment-relative, so the burn trims [0, segmentDuration].
        startSec: 0,
        endSec: segmentDuration,
        customizations: clip.customizations,
        overlays: overlays.length > 0 ? overlays : undefined,
        aspectRatio: clip.aspect_ratio,
        smartCropOffset,
      });
      renderedBuf = burnResult.mp4;
      captionsVtt = burnResult.vtt;
      // OBS — ffmpeg burn stage exit breadcrumb.
      addPipelineBreadcrumb("ffmpeg_burn_complete", "info", {
        mp4_bytes: renderedBuf.length,
        vtt_bytes: Buffer.byteLength(captionsVtt, "utf8"),
      });
    } catch (err) {
      const errMsg = (err as Error).message;
      logger.error("ffmpeg subtitle burn failed", {
        job_id: job.id,
        clip_id: clip.id,
        error: errMsg,
      });
      captureRunJobError(err, job, clip, "ffmpeg_burn", {
        png_overlay_path: usePngOverlay,
      });
      throw new Error(`subtitle_burn_failed: ${errMsg.slice(0, 400)}`);
    }

    // ── Step 7.5 — Free-tier watermark ──────────────────────────────────
    // Résout le plan réel du user (migration 0003 : colonne profiles.plan).
    // Free = watermark "AI clip · ClipsFlow". Tout autre plan = pas de watermark.
    const { resolvePlan } = await import("./quota");
    const { data: watermarkProfile } = await supabase
      .from("profiles")
      .select("plan")
      .eq("id", clip.user_id)
      .single();
    const plan = resolvePlan(watermarkProfile ?? null);
    if (plan === "free") {
      addPipelineBreadcrumb("watermark_start", "info", {
        mp4_bytes: renderedBuf.length,
      });
      try {
        const { applyClipWatermark } = await import("./watermark");
        renderedBuf = await applyClipWatermark(renderedBuf);
        addPipelineBreadcrumb("watermark_complete", "info", {
          mp4_bytes: renderedBuf.length,
        });
      } catch (err) {
        // Watermark is a revenue-protection feature, not a render-blocker.
        // If ffmpeg drawtext fails (font missing, malformed glyph), surface
        // to Sentry but ship the un-watermarked clip — losing the upgrade
        // hook is preferable to failing a Free user's first render and
        // forcing a refund.
        const errMsg = (err as Error).message;
        logger.warn(
          "ffmpeg watermark application failed (shipping unwatermarked)",
          {
            job_id: job.id,
            clip_id: clip.id,
            error: errMsg.slice(0, 400),
          },
        );
        captureRunJobError(err, job, clip, "watermark_apply");
      }
    }

    // ── Step 8 — Parallel mp4 + vtt uploads to Supabase Storage ────────
    // OBS — upload stage entry breadcrumb.
    addPipelineBreadcrumb("upload_start", "info", {
      mp4_bytes: renderedBuf.length,
      vtt_bytes: Buffer.byteLength(captionsVtt, "utf8"),
    });
    let captionsVttPath: string | null = null;
    const mp4UploadP = supabase.storage
      .from("clip-outputs")
      .upload(outPath, renderedBuf, {
        contentType: "video/mp4",
        // Deterministic {user_id}/{clip_id} path → retried jobs overwrite
        // their own partial artifacts instead of erroring on collision.
        upsert: true,
      });
    const vttUploadP = supabase.storage
      .from("clip-outputs")
      .upload(vttStoragePath, Buffer.from(captionsVtt, "utf8"), {
        // MIME exact — le bucket clip-outputs matche allowed_mime_types
        // strictement : un "; charset=" ferait échouer le sidecar VTT en
        // silence (review lot 2).
        contentType: "text/vtt",
        upsert: true,
      });
    const [mp4Result, vttResult] = await Promise.allSettled([
      mp4UploadP,
      vttUploadP,
    ]);

    if (mp4Result.status === "rejected") {
      const errMsg =
        (mp4Result.reason as Error)?.message ?? String(mp4Result.reason);
      logger.error("clip-outputs mp4 upload threw", {
        job_id: job.id,
        clip_id: clip.id,
        error: errMsg,
      });
      captureRunJobError(mp4Result.reason, job, clip, "mp4_upload", {
        upload_path: outPath,
      });
      throw new Error(`upload_failed: ${errMsg.slice(0, 400)}`);
    }
    if (mp4Result.value.error) {
      logger.error("clip-outputs mp4 upload failed", {
        job_id: job.id,
        clip_id: clip.id,
        error: mp4Result.value.error.message,
      });
      captureRunJobError(mp4Result.value.error, job, clip, "mp4_upload", {
        upload_path: outPath,
      });
      throw new Error(
        `upload_failed: ${mp4Result.value.error.message.slice(0, 400)}`,
      );
    }

    // VTT — best-effort, clip still usable without the <track> sidecar.
    if (vttResult.status === "rejected") {
      logger.warn("clip vtt upload threw", {
        job_id: job.id,
        clip_id: clip.id,
        error: (vttResult.reason as Error)?.message ?? String(vttResult.reason),
      });
    } else if (vttResult.value.error) {
      logger.warn("clip vtt upload failed (clip still ships, no <track>)", {
        job_id: job.id,
        clip_id: clip.id,
        error: vttResult.value.error.message,
      });
    } else {
      captionsVttPath = vttStoragePath;
    }

    // OBS — upload stage exit breadcrumb. Records whether the VTT sidecar
    // made it (best-effort upload — clip is still usable without it, but
    // the breadcrumb captures the degraded state for post-mortem).
    addPipelineBreadcrumb("upload_complete", "info", {
      mp4_uploaded: true,
      vtt_uploaded: captionsVttPath !== null,
    });

    // Poster / thumbnail extraction intentionally absent (P1, mirroring
    // the VidiaFlow removal of 2026-05-08) : the HTML5 <video> element
    // derives a gallery preview from the URL fragment `#t=0.5` for free.

    // Sign URLs in parallel (skipping any path that didn't upload).
    const [outSignedRes, vttSignedRes] = await Promise.all([
      supabase.storage.from("clip-outputs").createSignedUrl(outPath, 86400),
      captionsVttPath
        ? supabase.storage
            .from("clip-outputs")
            .createSignedUrl(captionsVttPath, 86400)
        : Promise.resolve({ data: null }),
    ]);

    const videoUrl = outSignedRes.data?.signedUrl ?? null;
    if (!videoUrl) {
      // The contract returns a non-null video_url — an upload that can't
      // be signed is as broken as a failed upload.
      throw new Error(
        "upload_failed: mp4 uploaded but signed URL creation returned no URL",
      );
    }
    const captionsVttUrl = vttSignedRes.data?.signedUrl ?? null;

    // ── Step 9 — Disclosure (AI Act art. 50 — synthetic subtitle overlay)
    // TODO(P2) : ClipsFlow has no disclosure audit table yet. The VidiaFlow
    // source wrote a best-effort `logDisclosure()` row here. Until the
    // disclosure schema lands, emit a structured console.warn so the
    // forensic trail exists in platform logs (NO phantom table writes).
    console.warn(
      JSON.stringify({
        level: "warn",
        source: "clips-run-job",
        message: "disclosure_log_todo_p2",
        detail:
          "AI Act art. 50 disclosure not persisted — disclosure table absent in P1",
        surface: "clip_subtitle",
        user_id: clip.user_id,
        clip_id: clip.id,
        locale: clip.language,
      }),
    );

    // Cost estimate rolled up for the admin dashboard (mono-1080p).
    const { computeClipCost } = await import("./cost");
    const cost_usd = computeClipCost(durationSeconds);

    // Hook score + hook text : heuristic 0-100 predictor based on the
    // first sentence of the transcript. No LLM, no extra wall-clock.
    const { computeHookScore, firstSentence } = await import("./hook-score");
    const transcriptText = words.map((w) => w.text).join(" ");
    const score = computeHookScore(transcriptText);
    const sentence = firstSentence(transcriptText);
    const hook_text = sentence.length > 0 ? sentence : null;

    return {
      video_url: videoUrl,
      video_storage_path: outPath,
      captions_vtt_url: captionsVttUrl,
      captions_vtt_storage_path: captionsVttPath,
      thumbnail_url: null,
      thumbnail_storage_path: null,
      cost_usd,
      score,
      hook_text,
      detected_language: detectedLanguage ?? null,
    };
  } finally {
    // Always clean up every /tmp artifact on exit (success or throw).
    // /tmp persists across warm invocations ; leaked media pollutes the
    // next job's disk budget. Best-effort — if an unlink fails the OS
    // reclaims /tmp on instance recycle.
    const tmpFiles = [sourcePath, segmentPath, audiogramPath].filter(
      (p): p is string => typeof p === "string",
    );
    await Promise.all(
      tmpFiles.map((p) =>
        unlink(p).catch((err) => {
          logger.warn("clips tmp file unlink failed", {
            job_id: job.id,
            path: p,
            error: (err as Error).message,
          });
        }),
      ),
    );
  }
}
