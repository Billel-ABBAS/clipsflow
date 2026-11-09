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
  CLIPS_OPEN_AUDIO_ENABLED: "true",
  CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED: "true",
  CLIPS_OPEN_AUDIO_BASE_URL: "https://audio.example.test",
  CLIPS_OPEN_AUDIO_API_KEY: "private-test-token",
};

const withFreshWorker = (
  environment: ShortsProviderEnvironment = configuredEnvironment,
) =>
  resolveShortsProviderCapabilities(environment, {
    analysisWorkerHeartbeatFresh: true,
  });

describe("Shorts provider capabilities", () => {
  it("keeps paid providers closed while separately authorized Open Audio remains available", () => {
    expect(
      withFreshWorker({
        ...configuredEnvironment,
        CLIPS_AI_BUDGET_AUTHORIZED: "false",
      }),
    ).toEqual({
      audioAnalysis: false,
      videoAnalysis: false,
      creativeDirection: false,
      elevenLabs: true,
    });
    expect(withFreshWorker({
      ...configuredEnvironment,
      CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED: "false",
    }).elevenLabs).toBe(false);
  });

  it("exposes analysis and creative providers only when their server configurations are ready", () => {
    expect(withFreshWorker()).toEqual({
      audioAnalysis: true,
      videoAnalysis: true,
      creativeDirection: true,
      elevenLabs: true,
    });
  });

  it("does not treat the rollout flag as proof of a running worker", () => {
    expect(
      resolveShortsProviderCapabilities(configuredEnvironment).audioAnalysis,
    ).toBe(false);
  });

  it("keeps queued analysis closed until the separate worker is declared ready", () => {
    const capabilities = withFreshWorker({
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
      withFreshWorker({
        ...configuredEnvironment,
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      }).audioAnalysis,
    ).toBe(false);

    const audioOnly = withFreshWorker({
      ...configuredEnvironment,
      CLIPS_VISUAL_ANALYSIS_ENABLED: "false",
    });
    expect(audioOnly.audioAnalysis).toBe(true);
    expect(audioOnly.videoAnalysis).toBe(false);
  });

  it("rejects public keys and configurations that the workers will reject", () => {
    expect(
      withFreshWorker({
        ...configuredEnvironment,
        NEXT_PUBLIC_ANTHROPIC_API_KEY: "misconfigured-public-key",
      }).creativeDirection,
    ).toBe(false);
    expect(
      withFreshWorker({
        ...configuredEnvironment,
        CLIPS_CREATIVE_DIRECTOR_MODEL: "claude-opus-5",
      }).creativeDirection,
    ).toBe(false);
    expect(
      withFreshWorker({
        ...configuredEnvironment,
        CLIPS_OPEN_AUDIO_BASE_URL: "http://untrusted.example.test",
      }).elevenLabs,
    ).toBe(false);
    expect(
      withFreshWorker({
        ...configuredEnvironment,
        NEXT_PUBLIC_OPENAI_API_KEY: "misconfigured-public-key",
      }).audioAnalysis,
    ).toBe(false);
    expect(withFreshWorker({
      ...configuredEnvironment,
      NEXT_PUBLIC_OPEN_AUDIO_API_KEY: "exposed",
    }).elevenLabs).toBe(false);
  });
});
