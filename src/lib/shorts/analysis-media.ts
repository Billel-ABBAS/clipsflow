// ============================================================================
// ClipsFlow Shorts — bounded media handling for the long-form worker
// ============================================================================

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  open,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import ffmpegPath from "@ffmpeg-installer/ffmpeg";

import { verifySourceMagicBytes } from "@/lib/clips/verify-magic-bytes";
import { probeHasVideoStream } from "@/lib/clips/mp4-probe";
import { attachFfmpegTimeout } from "@/lib/clips/ffmpeg-timeout";
import { resolveShortsSourceMaxBytes } from "./source-upload";
import {
  defaultClipsAllowedHosts,
  OutboundUrlError,
  validateOutboundUrl,
} from "@/lib/security/validate-outbound-url";
import { safeFetch } from "@/lib/utils/safe-fetch";

import type { LongformCandidateWindow } from "@/lib/clips/longform-analysis";
import type { ShortsVisualFrameSet } from "./visual-analysis";

const MIN_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
// Large resumably-uploaded sources may download slowly on a small worker.
// Bound the transfer, but allow up to four hours for an 8 GiB source.
const MAX_DOWNLOAD_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_MEDIA_PROBE_TIMEOUT_MS = 60 * 1_000;

export interface LongformSourceEpisode {
  id: string;
  user_id: string;
  source_type: "upload" | "url";
  source_url: string | null;
  source_storage_path: string | null;
  status: string;
}

export interface LongformAudioChunkRange {
  index: number;
  start_seconds: number;
  end_seconds: number;
  skip_leading_seconds: number;
}

export interface ProbedLongformMedia {
  durationSeconds: number;
  hasVideo: boolean;
}

function configuredMaxSourceBytes(): number {
  const value = resolveShortsSourceMaxBytes(
    process.env.SHORTS_MAX_SOURCE_BYTES,
  );
  return value >= MIN_MAX_SOURCE_BYTES ? value : resolveShortsSourceMaxBytes();
}

export const MAX_SHORTS_SOURCE_BYTES = configuredMaxSourceBytes();

/** Deterministic audio-only windows, with overlap removed during merge. */
export function buildLongformAudioChunkRanges(
  durationSeconds: number,
  chunkSeconds = 600,
  overlapSeconds = 30,
): LongformAudioChunkRange[] {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(chunkSeconds) ||
    chunkSeconds <= 0 ||
    !Number.isFinite(overlapSeconds) ||
    overlapSeconds < 0 ||
    overlapSeconds >= chunkSeconds
  ) {
    throw new Error("shorts_audio_chunk_options_invalid");
  }
  const ranges: LongformAudioChunkRange[] = [];
  let start = 0;
  while (start < durationSeconds) {
    const end = Math.min(durationSeconds, start + chunkSeconds);
    ranges.push({
      index: ranges.length,
      start_seconds: Math.round(start * 1_000) / 1_000,
      end_seconds: Math.round(end * 1_000) / 1_000,
      skip_leading_seconds: ranges.length === 0 ? 0 : overlapSeconds,
    });
    if (end >= durationSeconds) break;
    start = end - overlapSeconds;
  }
  return ranges;
}

function sourceAllowedHosts(
  source: LongformSourceEpisode,
): string[] | undefined {
  if (source.source_storage_path) return defaultClipsAllowedHosts();
  return undefined;
}

export async function resolveLongformSourceUrl(
  admin: import("@supabase/supabase-js").SupabaseClient,
  source: LongformSourceEpisode,
): Promise<{ url: string; allowedHosts?: string[] }> {
  try {
    if (source.source_url) {
      validateOutboundUrl(source.source_url);
      return { url: source.source_url };
    }
    if (!source.source_storage_path) throw new Error("source_missing");
    const { data, error } = await admin.storage
      .from("clip-sources")
      .createSignedUrl(source.source_storage_path, 6 * 60 * 60);
    if (error || !data?.signedUrl) throw new Error("source_sign_failed");
    const allowedHosts = sourceAllowedHosts(source);
    validateOutboundUrl(data.signedUrl, { allowedHosts });
    return { url: data.signedUrl, allowedHosts };
  } catch (error) {
    if (error instanceof OutboundUrlError) {
      throw new Error("source_url_rejected");
    }
    throw new Error("source_unavailable");
  }
}

/** Stream a validated media source to disk with size, time, and byte checks. */
export async function downloadLongformSource(
  url: string,
  allowedHosts?: string[],
): Promise<{ path: string; bytes: number; contentType: string | null }> {
  validateOutboundUrl(url, { allowedHosts });
  const path = join(tmpdir(), `clipsflow-shorts-source-${randomUUID()}.media`);
  let contentType: string | null = null;
  try {
    const response = await safeFetch(url, {
      timeoutMs: 60_000,
      allowedHosts,
    });
    if (!response.ok || !response.body)
      throw new Error("source_download_failed");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_SHORTS_SOURCE_BYTES) {
      throw new Error("source_too_large");
    }
    contentType = response.headers.get("content-type");
    const input = Readable.fromWeb(
      response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    const output = createWriteStream(path, { flags: "wx" });
    let total = 0;
    let tooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      input.destroy(new Error("source_download_timeout"));
    }, MAX_DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    input.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_SHORTS_SOURCE_BYTES) {
        tooLarge = true;
        input.destroy(new Error("source_too_large"));
      }
    });
    try {
      await pipeline(input, output);
    } catch {
      if (tooLarge) throw new Error("source_too_large");
      if (timedOut) throw new Error("source_download_timeout");
      throw new Error("source_download_failed");
    } finally {
      clearTimeout(timer);
    }
    const size = (await stat(path)).size;
    if (size <= 0 || size > MAX_SHORTS_SOURCE_BYTES) {
      throw new Error("source_download_invalid_size");
    }

    const file = await open(path, "r");
    const header = Buffer.alloc(16);
    let bytesRead = 0;
    try {
      ({ bytesRead } = await file.read(header, 0, header.length, 0));
    } finally {
      await file.close();
    }
    if (
      !verifySourceMagicBytes(header.subarray(0, bytesRead), contentType).ok
    ) {
      throw new Error("source_media_type_invalid");
    }
    return { path, bytes: size, contentType };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error instanceof Error ? error : new Error("source_download_failed");
  }
}

function runFfmpeg(
  args: string[],
  label: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath.path, args, { windowsHide: true });
    const watchdog = attachFfmpegTimeout(child, label, timeoutMs);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // ffmpeg probe output is small, but keep malformed-media output bounded.
      if (stderr.length < 64_000)
        stderr += chunk.toString().slice(0, 64_000 - stderr.length);
    });
    child.on("error", () => {
      watchdog.clear();
      reject(new Error(`${label}_failed`));
    });
    child.on("close", (code) => {
      watchdog.clear();
      if (watchdog.timedOut()) reject(new Error("shorts_media_probe_timeout"));
      else if (code === 0 || label === "shorts_media_probe") resolve(stderr);
      else reject(new Error(`${label}_failed`));
    });
  });
}

/** Probe the media with ffmpeg; never trust browser-declared duration/type. */
export async function probeLongformMedia(
  path: string,
): Promise<ProbedLongformMedia> {
  const stderr = await runFfmpeg(
    ["-hide_banner", "-i", path, "-f", "null", "-t", "0", "-"],
    "shorts_media_probe",
    MAX_MEDIA_PROBE_TIMEOUT_MS,
  );
  const match = stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/u);
  if (!match) throw new Error("source_duration_probe_failed");
  const durationSeconds =
    Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("source_duration_probe_failed");
  }
  const hasVideo = await probeHasVideoStream(path);
  return { durationSeconds, hasVideo };
}

export async function extractLongformAudioChunk(
  sourcePath: string,
  startSeconds: number,
  endSeconds: number,
  jobId: string,
): Promise<string> {
  const path = join(
    tmpdir(),
    `clipsflow-shorts-audio-${jobId}-${randomUUID()}.m4a`,
  );
  const duration = endSeconds - startSeconds;
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    duration <= 0 ||
    duration > 630
  ) {
    throw new Error("shorts_audio_chunk_invalid");
  }
  try {
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        startSeconds.toFixed(3),
        "-i",
        sourcePath,
        "-t",
        duration.toFixed(3),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-y",
        path,
      ],
      "shorts_audio_extract",
      10 * 60_000,
    );
    if ((await stat(path)).size < 1) throw new Error("shorts_audio_empty");
    return path;
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

/** Extract at most eight small JPEGs per already-ranked candidate. */
export async function extractCandidateVisualFrames(
  sourcePath: string,
  candidates: readonly LongformCandidateWindow[],
): Promise<ShortsVisualFrameSet[]> {
  if (candidates.length < 1 || candidates.length > 12) {
    throw new Error("shorts_visual_candidate_count_invalid");
  }
  const result: ShortsVisualFrameSet[] = [];
  for (const candidate of candidates) {
    const duration = candidate.end_seconds - candidate.start_seconds;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 180) {
      throw new Error("shorts_visual_candidate_window_invalid");
    }
    const directory = await mkdtemp(join(tmpdir(), "clipsflow-shorts-frames-"));
    try {
      const interval = Math.max(4, Math.floor(duration / 6));
      const pattern = join(directory, "frame-%02d.jpg");
      await runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          candidate.start_seconds.toFixed(3),
          "-i",
          sourcePath,
          "-t",
          duration.toFixed(3),
          "-map",
          "0:V:0",
          "-an",
          "-vf",
          `fps=1/${interval},scale=480:480:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
          "-frames:v",
          "8",
          "-q:v",
          "6",
          "-threads",
          "1",
          "-y",
          pattern,
        ],
        "shorts_visual_frame_extract",
        3 * 60_000,
      );
      const filenames = (await readdir(directory))
        .filter((name) => /^frame-\d+\.jpg$/u.test(name))
        .sort((left, right) =>
          left.localeCompare(right, undefined, { numeric: true }),
        )
        .slice(0, 8);
      if (filenames.length === 0)
        throw new Error("shorts_visual_frames_missing");
      const frames = [];
      for (const [index, filename] of filenames.entries()) {
        const bytes = new Uint8Array(await readFile(join(directory, filename)));
        if (bytes.byteLength > 400 * 1024) {
          throw new Error("shorts_visual_frame_too_large");
        }
        frames.push({
          timestampSeconds:
            candidate.start_seconds + Math.min(duration, index * interval),
          bytes,
        });
      }
      result.push({ candidateId: candidate.id, frames });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return result;
}
