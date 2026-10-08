import { describe, expect, it } from "vitest";

import {
  resolveShortsProviderCapabilities,
  type ShortsProviderEnvironment,
} from "./provider-capabilities";

const configuredEnvironment: ShortsProviderEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  SHORTS_ANALYSIS_WORKER_READY: "true",
  OPENAI_API_KEY: "private-test-key",
  GROQ_API_KEY: "private-test-key",
  CLIPS_VISUAL_ANALYSIS_ENABLED: "true",
  CLIPS_VISUAL_ANALYSIS_PROVIDER: "gemini",
  GEMINI_API_KEY: "private-test-key",
  CLIPS_CREATIVE_DIRECTOR_ENABLED: "true",
  CLIPS_CREATIVE_DIRECTOR_MODEL: "claude-opus-5-5",
  ANTHROPIC_API_KEY: "private-test-key",
  CLIPS_ELEVENLABS_ENABLED: "true",
  ELEVENLABS_API_KEY: "private-test-key",
};

describe("Shorts provider capabilities", () => {
  it("fails closed when provider budgets are not authorized", () => {
    expect(
      resolveShortsProviderCapabilities({
        ...configuredEnvironment,
        CLIPS_AI_BUDGET_AUTHORIZED: "false",
      }),
    ).toEqual({
      audioAnalysis: false,
      videoAnalysis: false,
      creativeDirection: false,
      elevenLabs: false,
    });
  });

  it("exposes analysis and creative providers only when their server configurations are ready", () => {
    expect(resolveShortsProviderCapabilities(configuredEnvironment)).toEqual({
      audioAnalysis: true,
      videoAnalysis: true,
      creativeDirection: true,
      elevenLabs: true,
    });
  });

  it("keeps queued analysis closed until the separate worker is declared ready", () => {
    const capabilities = resolveShortsProviderCapabilities({
      ...configuredEnvironment,
      SHORTS_ANALYSIS_WORKER_READY: "false",
    });

    expect(capabilities.audioAnalysis).toBe(false);
    expect(capabilities.videoAnalysis).toBe(false);
    expect(capabilities.creativeDirection).toBe(true);
    expect(capabilities.elevenLabs).toBe(true);
  });

  it("requires a transcription provider and a configured visual provider", () => {
    expect(
      resolveShortsProviderCapabilities({
        ...configuredEnvironment,
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      }).audioAnalysis,
    ).toBe(false);

    const audioOnly = resolveShortsProviderCapabilities({
      ...configuredEnvironment,
      CLIPS_VISUAL_ANALYSIS_ENABLED: "false",
    });
    expect(audioOnly.audioAnalysis).toBe(true);
    expect(audioOnly.videoAnalysis).toBe(false);
  });

  it("rejects public keys and model overrides that the workers will reject", () => {
    expect(
      resolveShortsProviderCapabilities({
        ...configuredEnvironment,
        NEXT_PUBLIC_ANTHROPIC_API_KEY: "misconfigured-public-key",
      }).creativeDirection,
    ).toBe(false);
    expect(
      resolveShortsProviderCapabilities({
        ...configuredEnvironment,
        CLIPS_CREATIVE_DIRECTOR_MODEL: "claude-opus-5",
      }).creativeDirection,
    ).toBe(false);
    expect(
      resolveShortsProviderCapabilities({
        ...configuredEnvironment,
        CLIPS_ELEVENLABS_MUSIC_MODEL: "unexpected-model",
      }).elevenLabs,
    ).toBe(false);
    expect(
      resolveShortsProviderCapabilities({
        ...configuredEnvironment,
        NEXT_PUBLIC_OPENAI_API_KEY: "misconfigured-public-key",
      }).audioAnalysis,
    ).toBe(false);
  });
});
