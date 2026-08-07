// ============================================================================
// ClipsFlow Clips — audiogram base renderer (NEW module, no VidiaFlow source)
// ============================================================================
// Podcast episodes are frequently AUDIO-ONLY (mp3 / m4a / wav). The subtitle
// burn pipeline needs a video stream to draw captions onto, so this module
// synthesises one : a dark solid background (#0a0a0a) with a centered white
// waveform (ffmpeg `showwaves`, cline mode) driven by the segment audio.
//
// The returned MP4 becomes the INPUT of the standard subtitle burn
// (`burnSubtitles` with startSec=0 / endSec=durationSeconds) — captions,
// styles, overlays and watermark all reuse the exact same ASS/libass path
// as video sources. No second rendering pipeline to maintain.
//
// ffmpeg graph :
//   input 0  : lavfi `color=c=0x0a0a0a:size=WxH:rate=30:duration=D`
//   input 1  : the extracted audio segment (AAC .m4a from run-job)
//   filter   : [1:a]showwaves=s=W×(H/4):mode=cline:colors=white@0.85:rate=30
//              → overlaid on the background, vertically centered, full width
//   encode   : H.264 ultrafast yuv420p + AAC 128k + faststart
//
// Output : a /tmp MP4 path. THE CALLER OWNS CLEANUP (run-job unlinks it in
// its finally block — same lifecycle as the downloaded source + segment).
//
// Errors are thrown with the `audiogram_failed:` prefix so the cron worker
// can route/refund them like any other pipeline failure.
// ============================================================================

import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { ASPECT_RATIO_DIMENSIONS, type AspectRatio } from "./types";

/**
 * Render the audiogram base video for an audio-only clip segment.
 *
 * @param audioPath       /tmp path of the extracted audio segment (AAC m4a
 *                        preferred ; anything ffmpeg can decode works).
 * @param aspectRatio     Target output aspect — the canvas is generated at
 *                        the canonical 1080p-class dimensions for that ratio
 *                        (`ASPECT_RATIO_DIMENSIONS`), so the subsequent burn
 *                        crop is an identity pass.
 * @param durationSeconds Segment duration — hard output bound (`-t`).
 * @returns               /tmp path of the rendered MP4. Caller must unlink.
 * @throws Error with `audiogram_failed:` prefix on any ffmpeg failure.
 */
export async function renderAudiogramBase(
  audioPath: string,
  aspectRatio: AspectRatio,
  durationSeconds: number,
): Promise<string> {
  const [width, height] = ASPECT_RATIO_DIMENSIONS[aspectRatio];
  // Waveform band = ~25 % of frame height, rounded to even (libx264 and
  // the overlay filter both behave best on even dimensions).
  const waveHeight = Math.max(2, Math.round((height * 0.25) / 2) * 2);
  const outPath = join(tmpdir(), `pc-audiogram-${randomUUID()}.mp4`);

  const duration = Math.max(0.1, durationSeconds);
  const colorSrc = `color=c=0x0a0a0a:size=${width}x${height}:rate=30:duration=${duration.toFixed(2)}`;
  // showwaves cline mode : centered filled waveform. `colors=white@0.85`
  // = white at 0.85 opacity over the dark background. Full-ratio width.
  // The overlay centers the band vertically ((H-h)/2) on the canvas.
  const filterComplex =
    `[1:a]showwaves=s=${width}x${waveHeight}:mode=cline:colors=white@0.85:rate=30[waves];` +
    `[0:v][waves]overlay=x=0:y=(H-h)/2[outv]`;

  const args = [
    "-f",
    "lavfi",
    "-i",
    colorSrc,
    "-i",
    audioPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    // Audio muxed as AAC — the burn step that follows uses `-c:a copy`,
    // so the codec must be MP4-container-legal regardless of what the
    // extraction produced.
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    // Hard duration bound : the lavfi source already carries duration=D
    // but `-t` guards against an audio segment marginally longer than
    // declared (container rounding).
    "-t",
    duration.toFixed(2),
    "-y",
    outPath,
  ];

  try {
    await new Promise<void>((res, rej) => {
      const p = spawn(ffmpegPath.path, args);
      let stderrBuf = "";
      p.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
      p.on("error", rej);
      p.on("close", (code) => {
        if (code === 0) {
          res();
        } else {
          console.log(
            `[clips-audiogram] FAIL exit=${code} stderr=${JSON.stringify(stderrBuf.slice(-1200))}`,
          );
          rej(
            new Error(
              `ffmpeg audiogram exited ${code}: ${stderrBuf.slice(-600)}`,
            ),
          );
        }
      });
    });
    return outPath;
  } catch (err) {
    // Clean the partial output before surfacing — the caller only unlinks
    // paths it received, and a throw means it never receives this one.
    await unlink(outPath).catch(() => {});
    const msg = (err as Error).message;
    throw new Error(`audiogram_failed: ${msg.slice(0, 400)}`);
  }
}
