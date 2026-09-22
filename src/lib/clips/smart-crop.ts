// ============================================================================
// ClipsFlow Clips — saliency-based smart crop
// ============================================================================
// When the user's source aspect ratio differs from the target output
// (typical case : 16:9 long-form → 9:16 TikTok crop), the default
// `crop=min(iw,ih*r):min(ih,iw/r)` filter centers the rectangle. If
// the talking head is off-center (right-third for podcast 2-shots,
// left-third for vlog frames with on-screen captions, etc.) the
// vertical crop slices the subject in half.
//
// This module computes a horizontal saliency-driven offset so the crop
// rectangle re-centers around the busy column (= subject). No ML, no
// model load, no extra binary — just :
//   1. Extract the first ~1s frame via the bundled ffmpeg installer
//   2. Resize 320×180 grayscale via sharp (~50 ms)
//   3. Sobel-style column-variance scan (~10 ms)
//   4. Peak column → normalized offset 0-1
//
// Wall-clock impact ~0.5-1 s vs ~70 s baseline burn = +1 % overhead.
// Runs once per clip, before the burn ffmpeg invocation.
//
// Fallback : when the analysis can't decide (uniform frame, single-
// color screens, error path), returns null — caller defaults to the
// existing center-crop behaviour.
//
// Ported from VidiaFlow src/lib/clipflow/smart-crop.ts (unchanged logic —
// the source already used ffmpeg frame extract + sharp, no Remotion).
// ============================================================================

import sharp from "sharp";
import { spawn } from "node:child_process";
import { attachFfmpegTimeout } from "./ffmpeg-timeout";

// Width × height of the analysis frame. Smaller = faster. 320×180
// preserves enough detail to localize a face within ±5 % of the
// horizontal axis, which is well below the visual error threshold for
// a 1080×1920 vertical crop.
//
// Exported so unit tests can synthesise frames of matching dimensions
// without grep-and-replace risk, and so future composability (e.g.
// shared with the PNG overlay spike) reuses the same constants.
export const ANALYSIS_W = 320;
export const ANALYSIS_H = 180;

/**
 * Extract a single JPEG frame near the start of the source video using
 * the bundled `@ffmpeg-installer/ffmpeg` binary. Returns the raw bytes
 * suitable for `sharp(buffer)`.
 *
 * Frame chosen at t=1.0 s when source duration allows — avoids the
 * black fade-in that some long-forms ship with at t=0. Falls back to
 * t=0 if the source is shorter than 1.5 s.
 */
async function extractFirstFrameJpeg(sourceUrl: string): Promise<Buffer> {
  const { path: ffmpegPath } = await import("@ffmpeg-installer/ffmpeg");
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1.0",
      "-i",
      sourceUrl,
      "-frames:v",
      "1",
      "-q:v",
      "5",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ];
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const watchdog = attachFfmpegTimeout(child, "smart_crop", 30_000);
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (error) => {
      watchdog.clear();
      reject(error);
    });
    child.on("close", (code) => {
      watchdog.clear();
      if (watchdog.timedOut()) {
        reject(new Error(watchdog.message()));
        return;
      }
      if (code !== 0 || chunks.length === 0) {
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Compute the column with the highest luminance variance — proxy for
 * "the busy part of the frame". On a typical talking-head clip this
 * lands on the speaker's face ; on a B-roll product shot it lands on
 * the product. Skips the 10 % left/right margins to avoid latching
 * onto chyron/title-safe areas.
 */
function findPeakColumn(grayPixels: Buffer): number {
  // grayPixels is an `ANALYSIS_W * ANALYSIS_H` byte array — one
  // luminance value per pixel, row-major order.
  const colSums = new Float32Array(ANALYSIS_W);
  const colSqSums = new Float32Array(ANALYSIS_W);
  for (let y = 0; y < ANALYSIS_H; y++) {
    for (let x = 0; x < ANALYSIS_W; x++) {
      const v = grayPixels[y * ANALYSIS_W + x];
      colSums[x] += v;
      colSqSums[x] += v * v;
    }
  }
  // Variance = E[X²] - E[X]². Pixels in [0,255] → variance ∈ [0, 16320].
  const margin = Math.floor(ANALYSIS_W * 0.1);
  let peakX = Math.floor(ANALYSIS_W / 2);
  let peakVar = 0;
  for (let x = margin; x < ANALYSIS_W - margin; x++) {
    const mean = colSums[x] / ANALYSIS_H;
    const meanSq = colSqSums[x] / ANALYSIS_H;
    const variance = meanSq - mean * mean;
    if (variance > peakVar) {
      peakVar = variance;
      peakX = x;
    }
  }
  return peakX;
}

/**
 * Public API : returns a normalized horizontal offset 0-1 (0 = left
 * edge, 1 = right edge) for where the subject lives in the source
 * frame. Caller multiplies by `(iw - ow)` to get the ffmpeg `crop=`
 * X argument. Returns `null` on extraction / analysis failure ; the
 * caller MUST default to centered crop in that case.
 *
 * @param sourceUrl HTTPS URL OR local filesystem path of the source —
 *                  both are passed verbatim to ffmpeg `-i`. The ClipsFlow
 *                  render worker passes the extracted /tmp segment path.
 */
export async function computeSmartCropOffset(
  sourceUrl: string,
): Promise<number | null> {
  try {
    const frameBuffer = await extractFirstFrameJpeg(sourceUrl);
    const { data, info } = await sharp(frameBuffer)
      .resize(ANALYSIS_W, ANALYSIS_H, { fit: "cover" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== ANALYSIS_W || info.height !== ANALYSIS_H) {
      return null;
    }
    const peakX = findPeakColumn(data);
    return peakX / ANALYSIS_W;
  } catch {
    return null;
  }
}
