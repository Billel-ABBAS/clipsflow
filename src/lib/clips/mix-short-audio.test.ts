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
    expect(filter).toContain("adelay=2200:all=1");
    expect(filter).toContain("apad=whole_len=960000");
    expect(filter).toContain("amix=inputs=3");
    expect(filter).toContain("volume=3,alimiter=limit=0.95");
  });

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
