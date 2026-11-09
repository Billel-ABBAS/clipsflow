import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { describe, expect, it } from "vitest";
import { mixShortAudio, mixShortNarration } from "./mix-short-audio";

function ffmpeg(args: string[]): Buffer {
  return execFileSync(ffmpegPath.path, [
    "-hide_banner", "-loglevel", "error", "-threads", "1", ...args,
  ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
}
function frames(path: string): string[] {
  return ffmpeg(["-i", path, "-map", "0:v:0", "-f", "framemd5", "pipe:1"])
    .toString("utf8").split("\n").filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)!.trim());
}

describe("Railway FFmpeg audio integration", () => {
  it("renders real music, SFX and narration without losing frames or truncating the source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clipsflow-audio-test-"));
    try {
      const source = join(dir, "source.mp4");
      const music = join(dir, "music.mp3");
      const effect = join(dir, "effect.mp3");
      const narration = join(dir, "narration.wav");
      const result = join(dir, "result.mp4");
      ffmpeg([
        "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ac", "2", "-t", "2", source,
      ]);
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1", "-c:a", "libmp3lame", music]);
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=1760:sample_rate=48000:duration=4", "-c:a", "libmp3lame", effect]);
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=24000:duration=0.4", "-c:a", "pcm_s16le", narration]);
      const mixed = await mixShortAudio(await readFile(source), await readFile(music), 2, {
        bytes: await readFile(effect), atSeconds: 0.2,
      });
      const narrated = await mixShortNarration(mixed, await readFile(narration), 2);
      await writeFile(result, narrated);
      expect(frames(result)).toEqual(frames(source));
      const pcm = ffmpeg(["-i", result, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
      const samples = pcm.byteLength / 4;
      expect(samples / 8000).toBeGreaterThan(1.8);
      expect(samples / 8000).toBeLessThan(2.2);
      let lateEnergy = 0;
      for (let index = 12_000; index < 14_000; index++) {
        const value = pcm.readFloatLE(index * 4);
        expect(Number.isFinite(value)).toBe(true);
        lateEnergy += value * value;
      }
      expect(Math.sqrt(lateEnergy / 2000)).toBeGreaterThan(0.001);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
