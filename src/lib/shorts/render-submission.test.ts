import { describe, expect, it } from "vitest";

import type { ShortsProductionProfile } from "./project-contract";
import {
  hasAuthorizedShortsMusic,
  shortsMotionAnimationSpeed,
  shortsRenderRequestId,
  shortsTitleCardOverlay,
} from "./render-submission";

const profile: ShortsProductionProfile = {
  aspect_ratio: "9:16",
  subtitle_style: "premium",
  subtitles: { synchronized: true, auto_emphasis: true },
  motion: {
    template: "kinetic-captions",
    reduced_motion: false,
    renderer: "deterministic",
  },
  elevenlabs: {
    enabled: false,
    explicit_consent: false,
    commercial_license_confirmed: false,
    use_cases: [],
    synthetic_voice: false,
  },
  creative_direction: {
    enabled: false,
    explicit_consent: false,
  },
};

describe("Shorts render submission", () => {
  it("requires authorized instrumental music before a Shorts render can be queued", () => {
    expect(hasAuthorizedShortsMusic(profile)).toBe(false);
    expect(
      hasAuthorizedShortsMusic({
        ...profile,
        elevenlabs: {
          enabled: true,
          explicit_consent: true,
          commercial_license_confirmed: true,
          use_cases: ["instrumental_music"],
          synthetic_voice: false,
        },
      }),
    ).toBe(true);
  });

  it("rejects audio authorization without explicit consent, rights, or the music use case", () => {
    const enabledWithoutLicense: ShortsProductionProfile = {
      ...profile,
      elevenlabs: {
        enabled: true,
        explicit_consent: true,
        commercial_license_confirmed: false,
        use_cases: ["instrumental_music"],
        synthetic_voice: false,
      },
    };
    const effectsOnly: ShortsProductionProfile = {
      ...enabledWithoutLicense,
      elevenlabs: {
        enabled: true,
        explicit_consent: true,
        commercial_license_confirmed: true,
        use_cases: ["sound_effects"],
        synthetic_voice: false,
      },
    };

    expect(hasAuthorizedShortsMusic(enabledWithoutLicense)).toBe(false);
    expect(hasAuthorizedShortsMusic(effectsOnly)).toBe(false);
  });

  it("creates stable idempotency IDs that change with the production profile", () => {
    const first = shortsRenderRequestId("project", "candidate", profile);
    expect(first).toBe(shortsRenderRequestId("project", "candidate", profile));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    expect(first).not.toBe(
      shortsRenderRequestId("project", "candidate", {
        ...profile,
        aspect_ratio: "1:1",
      }),
    );
  });

  it("maps the motion selection to bounded caption animation speeds", () => {
    expect(shortsMotionAnimationSpeed("punchy-cuts", false)).toBe(1.4);
    expect(shortsMotionAnimationSpeed("minimal-static", false)).toBe(0.5);
    expect(shortsMotionAnimationSpeed("punchy-cuts", true)).toBe(0.75);
  });

  it("creates an escaped-input-ready intro card and omits it for static motion", () => {
    expect(
      shortsTitleCardOverlay(
        "  A\nnew idea  ",
        "A useful hook",
        40,
        "editorial-focus",
      ),
    ).toEqual({
      type: "title_card",
      text: "A new idea",
      subtitle: "A useful hook",
      startSec: 0,
      endSec: 2.5,
      font: "Inter Bold",
      animationPreset: "editorial",
    });
    expect(
      shortsTitleCardOverlay("No intro", "", 10, "minimal-static"),
    ).toBeNull();
  });

  it("maps each visual motion template to its concrete intro animation", () => {
    const animationFor = (
      template: Parameters<typeof shortsTitleCardOverlay>[3],
    ) =>
      shortsTitleCardOverlay("A useful title", "A useful hook", 30, template)
        ?.animationPreset;

    expect(animationFor("punchy-cuts")).toBe("punch");
    expect(animationFor("kinetic-captions")).toBe("kinetic");
    expect(animationFor("editorial-focus")).toBe("editorial");
    expect(animationFor("audiogram-waveform")).toBe("editorial");
    expect(animationFor("calm-focus")).toBe("calm");
    expect(animationFor("minimal-static")).toBeUndefined();
  });
});
