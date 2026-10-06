import { describe, expect, it } from "vitest";

import {
  SHORTS_MAX_SELECTED_CANDIDATES,
  SHORTS_MAX_SOURCE_DURATION_SECONDS,
  SHORTS_MIN_SOURCE_DURATION_SECONDS,
  createShortsProjectSchema,
  normalizeShortsInstructions,
  selectShortsCandidatesSchema,
} from "./project-contract";

const episodeId = "1a7d0d3b-4598-4b0c-a1c5-b0d45d26b8f1";
const idempotencyKey = "1cab598e-e8bf-4e33-af05-b2a3f062346c";
const candidateIds = Array.from(
  { length: SHORTS_MAX_SELECTED_CANDIDATES },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

describe("long-form Shorts project contract", () => {
  it("normalizes bounded creator instructions and accepts the duration endpoints", () => {
    const parsed = createShortsProjectSchema.parse({
      episode_id: episodeId,
      analysis_mode: "audio_video",
      duration_seconds: SHORTS_MIN_SOURCE_DURATION_SECONDS,
      instructions: "  Crée\r\n\r\n des extraits\t utiles\u0000  ",
      idempotency_key: idempotencyKey,
    });

    expect(parsed.instructions).toBe("Crée\n\ndes extraits utiles");
    expect(parsed.jev_shadow_consent).toBe(false);
    expect(parsed.duration_seconds).toBe(SHORTS_MIN_SOURCE_DURATION_SECONDS);
    expect(
      createShortsProjectSchema.parse({
        ...parsed,
        duration_seconds: SHORTS_MAX_SOURCE_DURATION_SECONDS,
      }).duration_seconds,
    ).toBe(SHORTS_MAX_SOURCE_DURATION_SECONDS);
  });

  it("uses an empty instruction by default without loosening the strict body", () => {
    const parsed = createShortsProjectSchema.parse({
      episode_id: episodeId,
      analysis_mode: "audio",
      duration_seconds: 3_600,
      idempotency_key: idempotencyKey,
    });
    expect(parsed.instructions).toBe("");
    expect(parsed.jev_shadow_consent).toBe(false);
    expect(
      createShortsProjectSchema.parse({
        episode_id: episodeId,
        analysis_mode: "audio",
        duration_seconds: 3_600,
        idempotency_key: idempotencyKey,
        jev_shadow_consent: true,
      }).jev_shadow_consent,
    ).toBe(true);

    expect(
      createShortsProjectSchema.safeParse({
        episode_id: episodeId,
        analysis_mode: "audio",
        duration_seconds: 3_600,
        idempotency_key: idempotencyKey,
        role: "admin",
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range durations, fractional durations, and invalid idempotency keys", () => {
    const valid = {
      episode_id: episodeId,
      analysis_mode: "audio",
      duration_seconds: 3_600,
      idempotency_key: idempotencyKey,
    };

    expect(
      createShortsProjectSchema.safeParse({
        ...valid,
        duration_seconds: SHORTS_MIN_SOURCE_DURATION_SECONDS - 1,
      }).success,
    ).toBe(false);
    expect(
      createShortsProjectSchema.safeParse({
        ...valid,
        duration_seconds: SHORTS_MAX_SOURCE_DURATION_SECONDS + 1,
      }).success,
    ).toBe(false);
    expect(
      createShortsProjectSchema.safeParse({
        ...valid,
        duration_seconds: 1_200.5,
      }).success,
    ).toBe(false);
    expect(
      createShortsProjectSchema.safeParse({
        ...valid,
        idempotency_key: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("caps instructions after normalization and strips unsafe control characters", () => {
    expect(normalizeShortsInstructions("a\u0000\tb")).toBe("a b");
    expect(
      createShortsProjectSchema.safeParse({
        episode_id: episodeId,
        analysis_mode: "audio",
        duration_seconds: 3_600,
        instructions: "a".repeat(1_201),
        idempotency_key: idempotencyKey,
      }).success,
    ).toBe(false);
  });
});

describe("Shorts candidate selection contract", () => {
  const validProductionProfile = {
    aspect_ratio: "9:16",
    subtitle_style: "viral",
    subtitles: { synchronized: true, auto_emphasis: true },
    motion: {
      template: "kinetic-captions",
      reduced_motion: false,
      renderer: "deterministic",
    },
    elevenlabs: {
      enabled: true,
      explicit_consent: true,
      commercial_license_confirmed: true,
      use_cases: ["instrumental_music", "sound_effects"],
      synthetic_voice: false,
    },
    creative_direction: {
      enabled: false,
      explicit_consent: false,
    },
  } as const;

  it("accepts the exact bounded production profile after explicit ElevenLabs consent", () => {
    const parsed = selectShortsCandidatesSchema.parse({
      candidate_ids: candidateIds,
      production_profile: validProductionProfile,
    });

    expect(parsed.production_profile).toEqual(validProductionProfile);
  });

  it("fails closed for missing ElevenLabs consent or a missing commercial license", () => {
    const input = {
      candidate_ids: [candidateIds[0]],
      production_profile: validProductionProfile,
    };
    expect(
      selectShortsCandidatesSchema.safeParse({
        ...input,
        production_profile: {
          ...validProductionProfile,
          elevenlabs: {
            ...validProductionProfile.elevenlabs,
            explicit_consent: false,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      selectShortsCandidatesSchema.safeParse({
        ...input,
        production_profile: {
          ...validProductionProfile,
          elevenlabs: {
            ...validProductionProfile.elevenlabs,
            commercial_license_confirmed: false,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate candidate IDs and batches over the cap", () => {
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [candidateIds[0], candidateIds[0]],
        production_profile: validProductionProfile,
      }).success,
    ).toBe(false);
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [
          ...candidateIds,
          "00000000-0000-4000-8000-000000000999",
        ],
        production_profile: validProductionProfile,
      }).success,
    ).toBe(false);
  });

  it("rejects non-deterministic rendering and synthetic voice requests", () => {
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [candidateIds[0]],
        production_profile: {
          ...validProductionProfile,
          motion: { ...validProductionProfile.motion, renderer: "model" },
        },
      }).success,
    ).toBe(false);
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [candidateIds[0]],
        production_profile: {
          ...validProductionProfile,
          elevenlabs: {
            ...validProductionProfile.elevenlabs,
            synthetic_voice: true,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("allows a disabled ElevenLabs profile only with no saved consent", () => {
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [candidateIds[0]],
        production_profile: {
          ...validProductionProfile,
          elevenlabs: {
            ...validProductionProfile.elevenlabs,
            enabled: false,
            explicit_consent: false,
            commercial_license_confirmed: false,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [candidateIds[0]],
        production_profile: {
          ...validProductionProfile,
          elevenlabs: {
            ...validProductionProfile.elevenlabs,
            enabled: false,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires explicit project consent for optional Opus direction", () => {
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [candidateIds[0]],
        production_profile: {
          ...validProductionProfile,
          creative_direction: {
            enabled: true,
            explicit_consent: true,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      selectShortsCandidatesSchema.safeParse({
        candidate_ids: [candidateIds[0]],
        production_profile: {
          ...validProductionProfile,
          creative_direction: {
            enabled: true,
            explicit_consent: false,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      selectShortsCandidatesSchema.parse({
        candidate_ids: [candidateIds[0]],
        production_profile: {
          aspect_ratio: "9:16",
          subtitle_style: "viral",
          subtitles: { synchronized: true, auto_emphasis: true },
          motion: {
            template: "kinetic-captions",
            reduced_motion: false,
            renderer: "deterministic",
          },
          elevenlabs: validProductionProfile.elevenlabs,
        },
      }).production_profile.creative_direction,
    ).toEqual({ enabled: false, explicit_consent: false });
  });
});
