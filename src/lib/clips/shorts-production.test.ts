import { describe, expect, it } from "vitest";

import {
  MAX_SHORT_DURATION_SECONDS,
  mapShortsProductionInstructions,
} from "./shorts-production";

describe("mapShortsProductionInstructions", () => {
  it("maps an analysed video short to licensed, speech-safe production instructions", () => {
    const instructions = mapShortsProductionInstructions({
      selectedShort: {
        startSeconds: 120,
        endSeconds: 165.4,
        aspectRatio: "9:16",
        styleKey: "viral",
        sourceKind: "video",
        transcript: "Une voix est présente sur tout le passage.",
      },
      analysis: {
        hookScore: 91,
        tone: "inspirational",
        pace: "fast",
        speechCoverage: 0.85,
        themes: [" Technology ", "not-a-catalog-filter", "technology"],
        requestVisualAnalysis: true,
        requestElevenLabsSoundDesign: true,
      },
      soundDesignAuthorization: {
        explicitUserConsent: true,
        commercialLicenseConfirmed: true,
      },
    });

    expect(instructions.selectedShort).toEqual({
      startSeconds: 120,
      endSeconds: 165.4,
      durationSeconds: 45.4,
      aspectRatio: "9:16",
      sourceKind: "video",
    });
    expect(instructions.music).toMatchObject({
      action: "recommend-only",
      generated: false,
      mood: "uplifting",
      energy: "high",
      catalogQuery: {
        source: "licensed-catalog-only",
        musicGeneration: "never",
        requiredLicense: "commercial-social-sync",
        instrumentalOnly: true,
        excludeExplicitContent: true,
        themes: ["technology"],
        targetBpm: { min: 96, max: 122 },
        maxTrackDurationSeconds: 46,
      },
    });
    expect(instructions.voiceDucking).toEqual({
      enabled: true,
      musicGainDuringSpeechDb: -22,
      attackMs: 80,
      releaseMs: 280,
    });
    expect(instructions.elevenLabsSoundDesign).toEqual({
      provider: "elevenlabs",
      execution: "ready-for-authorized-worker",
      action: "plan-only",
      authorization: {
        requiresExplicitUserConsent: true,
        explicitUserConsent: true,
        commercialLicenseRequired: true,
        commercialLicenseConfirmed: true,
      },
      syntheticVoice: "prohibited",
      shortSfx: {
        modelId: "eleven_text_to_sound_v2",
        maximumEffects: 2,
        providerDurationBoundsSeconds: { min: 0.5, max: 30 },
        productionDurationBoundsSeconds: { min: 0.5, max: 3 },
        requestedDurationSeconds: 3,
        loop: false,
        spokenContent: "prohibited",
      },
      backgroundMusic: {
        modelId: "music_v2_5",
        providerDurationBoundsMs: { min: 3000, max: 600000 },
        requestedDurationMs: 45400,
        instrumentalOnly: true,
        vocalContent: "prohibited",
      },
      voiceDucking: {
        enabled: true,
        musicGainDuringSpeechDb: -22,
        attackMs: 80,
        releaseMs: 280,
      },
    });
    expect(instructions.motion).toEqual({
      template: "punchy-cuts",
      reducedMotion: false,
      maxCutsPerMinute: 18,
      captionAnimation: "energetic",
    });
    expect(instructions.subtitles).toEqual({
      level: "high-impact",
      autoEmphasis: true,
      maxEmphasizedWordsPerCue: 3,
      triggers: ["numbers", "power-words", "calls-to-action"],
      animation: "pop",
    });
    expect(instructions.visualAnalysis).toEqual({
      kind: "selected-short-visual-analysis",
      requiresExplicitUserConsent: true,
      sourceScope: "selected-short-only",
      startSeconds: 120,
      endSeconds: 165.4,
      sampleRateFps: 1,
      outputs: ["shot-boundaries", "subject-framing", "motion-level"],
      includeAudio: false,
      faceRecognition: "disabled",
      retainFrames: false,
      externalTransfer: "disabled",
    });
    expect(instructions.creativeDirector).toEqual({
      provider: "anthropic",
      model: "Claude Opus 5.5",
      availability: "waiting-for-official-api-model-id",
      action: "creative-direction-plan-only",
      scope: "selected-short-only",
      candidatePolicy: "final-selection-only",
      expectedOutputs: [
        "motion-beat-sheet",
        "subtitle-emphasis-refinement",
        "sound-placement-guidance",
      ],
    });
  });

  it("uses a static audiogram brief when motion must be reduced", () => {
    const instructions = mapShortsProductionInstructions({
      selectedShort: {
        startSeconds: 0,
        endSeconds: 30,
        aspectRatio: "1:1",
        styleKey: "minimal",
        sourceKind: "audio",
      },
      analysis: {
        hookScore: 20,
        tone: "reflective",
        pace: "slow",
        speechCoverage: 0,
        requestVisualAnalysis: true,
      },
      reducedMotion: true,
    });

    expect(instructions.music.generated).toBe(false);
    expect(instructions.music.mood).toBe("warm");
    expect(instructions.voiceDucking).toEqual({
      enabled: false,
      musicGainDuringSpeechDb: null,
      attackMs: null,
      releaseMs: null,
    });
    expect(instructions.motion).toEqual({
      template: "minimal-static",
      reducedMotion: true,
      maxCutsPerMinute: 0,
      captionAnimation: "none",
    });
    expect(instructions.subtitles).toMatchObject({
      level: "light",
      maxEmphasizedWordsPerCue: 1,
      animation: "none",
    });
    expect(instructions.visualAnalysis).toBeNull();
    expect(instructions.elevenLabsSoundDesign).toBeNull();
  });

  it("clamps untrusted numeric analysis metadata and allow-lists catalog themes", () => {
    const instructions = mapShortsProductionInstructions({
      selectedShort: {
        startSeconds: 10,
        endSeconds: 25,
        aspectRatio: "4:5",
        styleKey: "karaoke_pop",
        sourceKind: "video",
        transcript: "bonjour",
      },
      analysis: {
        hookScore: 900,
        pace: "fast",
        speechCoverage: 2,
        themes: ["FINANCE", "finance", "<script>alert(1)</script>"],
      },
    });

    expect(instructions.music.energy).toBe("high");
    expect(instructions.music.catalogQuery.themes).toEqual(["finance"]);
    expect(instructions.voiceDucking.musicGainDuringSpeechDb).toBe(-22);
  });

  it("rejects invalid or unsupported selected-short time ranges", () => {
    const base = {
      aspectRatio: "9:16" as const,
      styleKey: "viral" as const,
      sourceKind: "video" as const,
    };

    expect(() =>
      mapShortsProductionInstructions({
        selectedShort: { ...base, startSeconds: 20, endSeconds: 20 },
        analysis: {},
      }),
    ).toThrow("selected_short_time_range_invalid");
    expect(() =>
      mapShortsProductionInstructions({
        selectedShort: {
          ...base,
          startSeconds: 0,
          endSeconds: MAX_SHORT_DURATION_SECONDS + 1,
        },
        analysis: {},
      }),
    ).toThrow("selected_short_duration_exceeds_limit");
  });

  it("blocks a requested ElevenLabs plan until consent and commercial licensing are confirmed", () => {
    const instructions = mapShortsProductionInstructions({
      selectedShort: {
        startSeconds: 0,
        endSeconds: 3,
        aspectRatio: "9:16",
        styleKey: "minimal",
        sourceKind: "video",
      },
      analysis: { requestElevenLabsSoundDesign: true },
      soundDesignAuthorization: {
        explicitUserConsent: true,
        commercialLicenseConfirmed: false,
      },
    });

    expect(instructions.elevenLabsSoundDesign).toMatchObject({
      execution: "blocked-pending-consent",
      syntheticVoice: "prohibited",
      shortSfx: { requestedDurationSeconds: 3 },
      backgroundMusic: { requestedDurationMs: 3000 },
    });
  });
});
