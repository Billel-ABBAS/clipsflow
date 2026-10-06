import { describe, expect, it } from "vitest";
import { buildAudiogramFilterComplex } from "./render-audiogram";

describe("buildAudiogramFilterComplex", () => {
  it("animates the waveform by default for existing render behavior", () => {
    expect(buildAudiogramFilterComplex(1080, 480)).toContain("showwaves=");
  });

  it("keeps the background static when waveform motion is disabled", () => {
    expect(buildAudiogramFilterComplex(1080, 480, false)).toBe(
      "[0:v]null[outv]",
    );
  });
});
