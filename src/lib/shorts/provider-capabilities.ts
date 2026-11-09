import {
  CLAUDE_OPUS_5_5_MODEL_API_ID,
  CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED,
} from "@/lib/clips/creative-director-model";
import { resolveOpenAudioConfig } from "@/lib/clips/open-audio";
import { assertLongformOpenAIAvailable } from "./longform-openai";
import { resolveShortsVisualConfig } from "./visual-analysis";

export interface ShortsProviderEnvironment extends Record<
  string,
  string | undefined
> {
  CLIPS_AI_BUDGET_AUTHORIZED?: string;
  SHORTS_ANALYSIS_WORKER_READY?: string;
  CLIPS_FORCE_OPENAI_WHISPER?: string;
  OPENAI_API_KEY?: string;
  NEXT_PUBLIC_OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  NEXT_PUBLIC_GROQ_API_KEY?: string;
  CLIPS_VISUAL_ANALYSIS_ENABLED?: string;
  CLIPS_VISUAL_ANALYSIS_PROVIDER?: string;
  CLIPS_VISUAL_ANALYSIS_MODEL?: string;
  GEMINI_API_KEY?: string;
  NEXT_PUBLIC_GEMINI_API_KEY?: string;
  CLIPS_CREATIVE_DIRECTOR_ENABLED?: string;
  CLIPS_CREATIVE_DIRECTOR_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  NEXT_PUBLIC_ANTHROPIC_API_KEY?: string;
  CLIPS_OPEN_AUDIO_ENABLED?: string;
  CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED?: string;
  CLIPS_OPEN_AUDIO_BASE_URL?: string;
  CLIPS_OPEN_AUDIO_API_KEY?: string;
  NEXT_PUBLIC_OPEN_AUDIO_API_KEY?: string;
}

export interface ShortsProviderCapabilities {
  audioAnalysis: boolean;
  videoAnalysis: boolean;
  creativeDirection: boolean;
  /** Legacy serialized name; now represents self-hosted Open Audio configuration. */
  elevenLabs: boolean;
}

export interface ShortsProviderHealth {
  /** Must come from the protected database heartbeat, never an env flag. */
  analysisWorkerHeartbeatFresh: boolean;
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

function openAudioConfigured(environment: ShortsProviderEnvironment): boolean {
  try {
    resolveOpenAudioConfig(environment);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expose only readiness booleans to the browser; never serialize provider
 * keys, model errors, or other server configuration.
 */
export function isShortsAnalysisConfigurationEligible(
  environment: ShortsProviderEnvironment,
): boolean {
  const paidCallsAuthorized = environment.CLIPS_AI_BUDGET_AUTHORIZED === "true";
  const privateProviderConfiguration =
    !hasPrivateKey(environment.NEXT_PUBLIC_OPENAI_API_KEY) &&
    !hasPrivateKey(environment.NEXT_PUBLIC_GROQ_API_KEY) &&
    !hasPrivateKey(environment.NEXT_PUBLIC_GEMINI_API_KEY);
  const transcriptionProviderAvailable =
    environment.CLIPS_FORCE_OPENAI_WHISPER === "1"
      ? hasPrivateKey(environment.OPENAI_API_KEY)
      : hasPrivateKey(environment.GROQ_API_KEY) ||
        hasPrivateKey(environment.OPENAI_API_KEY);

  if (
    !paidCallsAuthorized ||
    environment.SHORTS_ANALYSIS_WORKER_READY !== "true" ||
    !privateProviderConfiguration ||
    !transcriptionProviderAvailable
  ) {
    return false;
  }

  try {
    assertLongformOpenAIAvailable(environment);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expose only configuration booleans to the browser, never private endpoints.
 * Open Audio configuration is not proof that its model server is healthy.
 */
export function resolveShortsProviderCapabilities(
  environment: ShortsProviderEnvironment,
  health: ShortsProviderHealth = { analysisWorkerHeartbeatFresh: false },
): ShortsProviderCapabilities {
  const paidCallsAuthorized = environment.CLIPS_AI_BUDGET_AUTHORIZED === "true";
  const audioAnalysis =
    health.analysisWorkerHeartbeatFresh &&
    isShortsAnalysisConfigurationEligible(environment);

  let videoAnalysis = false;
  if (audioAnalysis) {
    try {
      resolveShortsVisualConfig(environment);
      videoAnalysis = true;
    } catch {
      videoAnalysis = false;
    }
  }

  return {
    audioAnalysis,
    videoAnalysis,
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
    elevenLabs: openAudioConfigured(environment),
  };
}
