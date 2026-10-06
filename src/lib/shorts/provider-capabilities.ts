import {
  CLAUDE_OPUS_5_5_MODEL_API_ID,
  CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED,
} from "@/lib/clips/creative-director-model";
import {
  ELEVENLABS_MUSIC_MODEL,
  ELEVENLABS_SOUND_MODEL,
} from "@/lib/clips/elevenlabs";

export interface ShortsProviderEnvironment {
  CLIPS_AI_BUDGET_AUTHORIZED?: string;
  CLIPS_CREATIVE_DIRECTOR_ENABLED?: string;
  CLIPS_CREATIVE_DIRECTOR_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  NEXT_PUBLIC_ANTHROPIC_API_KEY?: string;
  CLIPS_ELEVENLABS_ENABLED?: string;
  CLIPS_ELEVENLABS_MUSIC_MODEL?: string;
  CLIPS_ELEVENLABS_SOUND_MODEL?: string;
  ELEVENLABS_API_KEY?: string;
  NEXT_PUBLIC_ELEVENLABS_API_KEY?: string;
}

export interface ShortsProviderCapabilities {
  creativeDirection: boolean;
  elevenLabs: boolean;
}

function hasPrivateKey(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function matchesConfiguredModel(
  configured: string | undefined,
  expected: string,
): boolean {
  const model = configured?.trim();
  return !model || model === expected;
}

/**
 * Expose only readiness booleans to the browser; never serialize provider
 * keys, model errors, or other server configuration.
 */
export function resolveShortsProviderCapabilities(
  environment: ShortsProviderEnvironment,
): ShortsProviderCapabilities {
  const paidCallsAuthorized = environment.CLIPS_AI_BUDGET_AUTHORIZED === "true";

  return {
    creativeDirection:
      paidCallsAuthorized &&
      CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED &&
      environment.CLIPS_CREATIVE_DIRECTOR_ENABLED === "true" &&
      hasPrivateKey(environment.ANTHROPIC_API_KEY) &&
      !hasPrivateKey(environment.NEXT_PUBLIC_ANTHROPIC_API_KEY) &&
      matchesConfiguredModel(
        environment.CLIPS_CREATIVE_DIRECTOR_MODEL,
        CLAUDE_OPUS_5_5_MODEL_API_ID,
      ),
    elevenLabs:
      paidCallsAuthorized &&
      environment.CLIPS_ELEVENLABS_ENABLED === "true" &&
      hasPrivateKey(environment.ELEVENLABS_API_KEY) &&
      !hasPrivateKey(environment.NEXT_PUBLIC_ELEVENLABS_API_KEY) &&
      matchesConfiguredModel(
        environment.CLIPS_ELEVENLABS_MUSIC_MODEL,
        ELEVENLABS_MUSIC_MODEL,
      ) &&
      matchesConfiguredModel(
        environment.CLIPS_ELEVENLABS_SOUND_MODEL,
        ELEVENLABS_SOUND_MODEL,
      ),
  };
}
