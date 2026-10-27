import { spawnSync } from "node:child_process";

import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { describe, expect, it } from "vitest";

import { buildShortAudioMixArgs } from "./mix-short-audio";

describe("Shorts instrumental audio mix", () => {
  it("ducks music under the source audio and limits the final mix", () => {
    const args = buildShortAudioMixArgs({
      videoPath: "video.mp4",
      musicPath: "music.mp3",
      outputPath: "output.mp4",
      durationSeconds: 40,
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("sidechaincompress");
    expect(filter).toContain("amix=inputs=2");
    expect(filter).toContain("volume=2,alimiter=limit=0.95");
    expect(args).toContain("-stream_loop");
    expect(args).toContain("-c:v");
    expect(args).toContain("copy");
  });

  it("places a non-verbal motion accent at a bounded clip offset", () => {
    const args = buildShortAudioMixArgs({
      videoPath: "video.mp4",
      musicPath: "music.mp3",
      soundEffectPath: "effect.mp3",
      soundEffectAtSeconds: 2.2,
      outputPath: "output.mp4",
      durationSeconds: 20,
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("adelay=2200|2200");
    expect(filter).toContain("apad=whole_len=960000");
    expect(filter).toContain("amix=inputs=3");
    expect(filter).toContain("volume=3,alimiter=limit=0.95");
  });

  it.each([false, true])(
    "executes the packaged FFmpeg mix with mismatched sample rates (accent=%s)",
    (withAccent) => {
      const args = buildShortAudioMixArgs({
        videoPath: "video.mp4",
        musicPath: "music.mp3",
        outputPath: "output.mp4",
        durationSeconds: 3,
        ...(withAccent
          ? { soundEffectPath: "effect.mp3", soundEffectAtSeconds: 0.7 }
          : {}),
      });
      const sources: Record<string, string> = {
        "video.mp4":
          "color=c=black:s=64x64:r=10:d=3[out0];sine=frequency=440:sample_rate=48000:duration=3[out1]",
        "music.mp3": "sine=frequency=880:sample_rate=44100:duration=3",
        "effect.mp3": "sine=frequency=1760:sample_rate=22050:duration=0.2",
      };
      const renderArgs: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (value === "-i") {
          const source = sources[args[index + 1]];
          if (!source) throw new Error("Unexpected synthetic input");
          renderArgs.push("-f", "lavfi", "-i", source);
          index += 1;
        } else if (value === "output.mp4") {
          renderArgs.push("-f", "null", "-");
        } else {
          renderArgs.push(value);
        }
      }
      const result = spawnSync(ffmpegPath.path, renderArgs, {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
    20_000,
  );

  it("rejects invalid mix windows and sound-effect offsets", () => {
    expect(() =>
      buildShortAudioMixArgs({
        videoPath: "video.mp4",
        musicPath: "music.mp3",
        outputPath: "output.mp4",
        durationSeconds: 0,
      }),
    ).toThrow("short_audio_mix_input_invalid");
    expect(() =>
      buildShortAudioMixArgs({
        videoPath: "video.mp4",
        musicPath: "music.mp3",
        soundEffectPath: "effect.mp3",
        soundEffectAtSeconds: 20,
        outputPath: "output.mp4",
        durationSeconds: 20,
      }),
    ).toThrow("short_audio_effect_offset_invalid");
  });
});
