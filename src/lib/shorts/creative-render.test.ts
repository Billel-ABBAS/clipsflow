import { describe, expect, it } from "vitest";

import type { CreativeDirectorResult } from "@/lib/clips/creative-director";
import type { ClipJob } from "@/lib/clips/types";
import {
  applyCreativeDirectionToShortsProfile,
  creativeMotionAnimationSpeed,
  resolveCreativeSoundAccent,
} from "./creative-render";

const shortsProfile = {
  project_id: "project",
  candidate_id: "candidate",
  title: "Original title",
  hook: "Original hook",
  music_mood: "focused",
  motion_direction: "A restrained edit",
  motion_template: "editorial-focus",
  reduced_motion: false,
  elevenlabs: {
    enabled: true,
    explicit_consent: true,
    commercial_license_confirmed: true,
    use_cases: ["instrumental_music", "sound_effects"],
    synthetic_voice: false,
  },
  creative_direction: {
    enabled: true,
    explicit_consent: true,
    user_instructions: "Keep it concise.",
    visual_summary: null,
  },
} satisfies NonNullable<ClipJob["customizations"]["shorts"]>;

const direction: CreativeDirectorResult = {
  version: "creative-direction-v1",
  title: "A sharper title",
  hook: "The short version.",
  rationale: "The selected moment lands its point quickly.",
  music: {
    mood: "uplifting",
    energy: "medium",
    instrumental_prompt: "Warm instrumental piano with a light pulse.",
  },
  motion: {
    template: "kinetic-captions",
    intensity: "energetic",
    beat_sheet: [
      {
        at_seconds: 4,
        action: "sound-accent",
        detail: "A soft transition accent at the key phrase.",
      },
    ],
  },
};

describe("Opus Shorts rendering adapter", () => {
  it("maps creative output to existing allow-listed deterministic settings", () => {
    expect(
      applyCreativeDirectionToShortsProfile(shortsProfile, direction),
    ).toMatchObject({
      title: "A sharper title",
      hook: "The short version.",
      music_mood: "uplifting",
      music_prompt: "Warm instrumental piano with a light pulse.",
      motion_template: "kinetic-captions",
    });
  });

  it("preserves reduced-motion preference even when Opus requests an animated preset", () => {
    const reducedProfile = { ...shortsProfile, reduced_motion: true };
    expect(
      applyCreativeDirectionToShortsProfile(reducedProfile, direction)
        .motion_template,
    ).toBe("minimal-static");
    expect(creativeMotionAnimationSpeed(reducedProfile, direction)).toBe(0.75);
  });

  it("uses at most one non-verbal ElevenLabs accent at the model-selected time", () => {
    expect(resolveCreativeSoundAccent(direction, 30)).toMatchObject({
      atSeconds: 4,
      durationSeconds: 1,
      prompt: expect.stringContaining("No voice, words, lyrics"),
    });
    expect(
      resolveCreativeSoundAccent(
        { ...direction, motion: { ...direction.motion, beat_sheet: [] } },
        30,
      ),
    ).toBeNull();
  });
});
