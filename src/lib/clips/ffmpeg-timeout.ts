import type { ChildProcess } from "node:child_process";

const DEFAULT_FFMPEG_TIMEOUT_MS = 300_000;

/**
 * Railway's staging worker is deliberately capped at one vCPU and 1 GiB of
 * memory.  Letting ffmpeg/x264 auto-size its decoder, filter, and lookahead
 * pools can oversubscribe that tiny container and cause the kernel to kill
 * only the ffmpeg child.  Keep every render pass deterministic and bounded.
 *
 * Filter options are global and therefore belong before the input.  x264
 * options belong after `-c:v libx264` in the output section.
 */
export const FFMPEG_SINGLE_CORE_FILTER_ARGS = [
  "-filter_threads",
  "1",
  "-filter_complex_threads",
  "1",
] as const;

export const FFMPEG_SINGLE_CORE_X264_ARGS = [
  "-threads",
  "1",
  "-x264-params",
  "threads=1:lookahead_threads=1:sync-lookahead=0",
] as const;

function configuredTimeoutMs(): number {
  const raw = process.env.CLIPS_FFMPEG_TIMEOUT_MS;
  const value = raw ? Number(raw) : NaN;
  // Keep a floor so an accidental environment value cannot kill every
  // process at startup. The cap prevents a typo from pinning Railway forever.
  return Number.isSafeInteger(value) && value >= 30_000 && value <= 600_000
    ? value
    : DEFAULT_FFMPEG_TIMEOUT_MS;
}

/**
 * Kill a runaway ffmpeg child and let the caller surface a typed failure on
 * `close`. The timer is unref'd so a clean one-shot worker exits immediately
 * after a normal render rather than waiting for the watchdog.
 */
export function attachFfmpegTimeout(
  child: ChildProcess,
  label: string,
  timeoutMs = configuredTimeoutMs(),
): { clear: () => void; timedOut: () => boolean; message: () => string } {
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();

  return {
    clear: () => clearTimeout(timer),
    timedOut: () => didTimeOut,
    message: () => `ffmpeg_timeout: ${label} exceeded ${timeoutMs / 1000}s`,
  };
}
