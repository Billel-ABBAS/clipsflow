// ============================================================================
// ClipsFlow Clips — Free-tier watermark applied post-burn
// ============================================================================
// Free plan users get an "AI clip · ClipsFlow" drawtext overlay burned in via
// ffmpeg before the final upload to the `clip-outputs` bucket. Applied AFTER
// the Whisper + libass pipeline returns the subtitle-burned MP4 (we
// re-encode once with the watermark filter on top of the already-rendered
// subtitles).
//
// drawtext params (mirror of the VidiaFlow ClipFlow watermark) :
//   text          'AI clip · ClipsFlow'
//   fontcolor     white@0.85     slightly transparent so it doesn't fight
//                                with on-screen subtitles
//   fontsize      h*0.045        ~4.5% of frame height (scales with aspect)
//   position      top-right with h*0.045 padding — high enough to clear
//                 the lower-third subtitle band.
//   shadow        black@0.55 + 2px offset for legibility on bright frames
//
// Notes :
//  - `-c:a copy` keeps audio unchanged (faster, no quality loss).
//  - tmp dir cleaned via `finally`. Function is safe to call concurrently
//    (each call gets its own `mkdtemp` workspace).
//  - In P1 the plan resolves to the constant 'pro' (see quota.ts >
//    resolvePlan) so this never fires in practice — ported anyway so the
//    free-tier gate works the day profiles.plan lands (TODO(P3)).
//
// Ported from VidiaFlow src/lib/clipflow/watermark.ts.
// Adaptations : watermark text "VidiaFlow" → "AI clip · ClipsFlow" ;
// function renamed applyClipflowWatermark → applyClipWatermark. ffmpeg
// logic otherwise identical.
// ============================================================================

import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Apply the "AI clip · ClipsFlow" drawtext watermark to a subtitle-burned
 * MP4. Returns the watermarked MP4 buffer. Throws on ffmpeg non-zero exit.
 *
 * Caller is responsible for tier-gating — this fn always watermarks.
 */
export async function applyClipWatermark(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "pcwm-"));
  const inPath = join(dir, "in.mp4");
  const outPath = join(dir, "out.mp4");
  try {
    await writeFile(inPath, input);
    await new Promise<void>((res, rej) => {
      // Top-right placement. The bottom band is reserved for the
      // user-visible subtitles (lower_third default — ~62 % from top),
      // so we anchor the watermark high to maximise contrast vs the
      // subtitle text. Padding scales with frame height so every aspect
      // renders proportionally.
      const args = [
        "-i",
        inPath,
        "-vf",
        "drawtext=text='AI clip · ClipsFlow':fontcolor=white@0.85:fontsize=h*0.045:x=w-tw-h*0.045:y=h*0.045:shadowcolor=black@0.55:shadowx=2:shadowy=2",
        "-c:a",
        "copy",
        "-y",
        outPath,
      ];
      const p = spawn(ffmpegPath.path, args);
      let stderrBuf = "";
      p.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
      p.on("error", rej);
      p.on("close", (code) => {
        if (code === 0) res();
        else rej(new Error(`ffmpeg exited ${code}: ${stderrBuf.slice(-500)}`));
      });
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
