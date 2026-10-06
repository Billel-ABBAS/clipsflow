import { describe, expect, it } from "vitest";

import {
  resolveShortsProviderCapabilities,
  type ShortsProviderEnvironment,
} from "./provider-capabilities";

const configuredEnvironment: ShortsProviderEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
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
    ).toEqual({ creativeDirection: false, elevenLabs: false });
  });

  it("exposes Opus 5.5 and ElevenLabs when both server configurations are ready", () => {
    expect(resolveShortsProviderCapabilities(configuredEnvironment)).toEqual({
      creativeDirection: true,
      elevenLabs: true,
    });
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
  });
});
