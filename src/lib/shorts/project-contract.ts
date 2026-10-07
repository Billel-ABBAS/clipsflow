// ============================================================================
// ClipsFlow Shorts — contracts for the long-form analysis journey
// ============================================================================
// This module is intentionally pure. Route handlers use it to validate every
// browser-controlled field before a project is inserted or candidate settings
// reach a worker. It neither reads environment variables nor calls providers.
// ============================================================================

import { z } from "zod";

import {
  SHORTS_MAX_SOURCE_DURATION_SECONDS,
  SHORTS_MIN_SOURCE_DURATION_SECONDS,
} from "./source-duration";

export {
  SHORTS_MAX_SOURCE_DURATION_SECONDS,
  SHORTS_MIN_SOURCE_DURATION_SECONDS,
} from "./source-duration";

export const SHORTS_MAX_INSTRUCTIONS_LENGTH = 1_200;
export const SHORTS_MAX_UNNORMALIZED_INSTRUCTIONS_LENGTH = 4_800;
export const SHORTS_MAX_SELECTED_CANDIDATES = 12;

export const shortsAnalysisModeSchema = z.enum(["audio", "audio_video"]);

export type ShortsAnalysisMode = z.infer<typeof shortsAnalysisModeSchema>;

export const SHORTS_MUSIC_MOODS = [
  "focused",
  "playful",
  "uplifting",
  "warm",
  "energetic",
  "minimal",
] as const;

export const shortsMusicMoodSchema = z.enum(SHORTS_MUSIC_MOODS);

export type ShortsMusicMood = z.infer<typeof shortsMusicMoodSchema>;

/**
 * Keep creator instructions compact and deterministic before they are sent to
 * an AI worker. Newlines remain meaningful; other control characters never
 * reach logs, prompts, or the database.
 */
export function normalizeShortsInstructions(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const normalizedInstructionsSchema = z
  .string()
  .max(SHORTS_MAX_UNNORMALIZED_INSTRUCTIONS_LENGTH)
  .transform(normalizeShortsInstructions)
  .refine(
    (value) => value.length <= SHORTS_MAX_INSTRUCTIONS_LENGTH,
    `instructions must be at most ${SHORTS_MAX_INSTRUCTIONS_LENGTH} characters after normalization`,
  );

/**
 * Input of POST /api/shorts/projects. `idempotency_key` is part of the body
 * so an interrupted browser request can be retried without creating a second
 * paid-analysis job.
 */
export const createShortsProjectSchema = z.strictObject({
  episode_id: z.uuid(),
  analysis_mode: shortsAnalysisModeSchema,
  duration_seconds: z
    .number()
    .int()
    .min(SHORTS_MIN_SOURCE_DURATION_SECONDS)
    .max(SHORTS_MAX_SOURCE_DURATION_SECONDS),
  instructions: normalizedInstructionsSchema.optional().default(""),
  // Transcript excerpts are never sent to the optional Jev shadow evaluator
  // unless the creator explicitly opts in for this project.
  jev_shadow_consent: z.boolean().default(false),
  idempotency_key: z.uuid(),
});

export type CreateShortsProjectInput = z.infer<
  typeof createShortsProjectSchema
>;

const elevenLabsProfileSchema = z
  .strictObject({
    enabled: z.boolean(),
    explicit_consent: z.boolean(),
    commercial_license_confirmed: z.boolean(),
    use_cases: z.array(z.enum(["instrumental_music", "sound_effects"])).max(2),
    synthetic_voice: z.literal(false),
  })
  .superRefine((value, context) => {
    if (
      value.enabled &&
      (!value.explicit_consent || !value.commercial_license_confirmed)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "ElevenLabs sound design requires explicit consent and commercial license confirmation",
      });
    }

    // A disabled option must not preserve an ambiguous stale authorisation.
    if (
      !value.enabled &&
      (value.explicit_consent || value.commercial_license_confirmed)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "ElevenLabs consent and license confirmation must be false when sound design is disabled",
      });
    }
  });

const creativeDirectionProfileSchema = z
  .strictObject({
    enabled: z.boolean(),
    explicit_consent: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.enabled !== value.explicit_consent) {
      context.addIssue({
        code: "custom",
        message:
          "Claude Opus creative direction requires explicit consent and must be disabled when consent is absent",
      });
    }
  });

const productionProfileSchema = z.strictObject({
  aspect_ratio: z.enum(["9:16", "1:1", "4:5", "16:9"]),
  subtitle_style: z.enum([
    "viral",
    "premium",
    "minimal",
    "karaoke_pop",
    "cinematic",
    "comic_bubble",
  ]),
  subtitles: z.strictObject({
    synchronized: z.literal(true),
    auto_emphasis: z.boolean(),
  }),
  motion: z.strictObject({
    template: z.enum([
      "punchy-cuts",
      "kinetic-captions",
      "editorial-focus",
      "calm-focus",
      "audiogram-waveform",
      "minimal-static",
    ]),
    reduced_motion: z.boolean(),
    renderer: z.literal("deterministic"),
  }),
  elevenlabs: elevenLabsProfileSchema,
  creative_direction: creativeDirectionProfileSchema.default({
    enabled: false,
    explicit_consent: false,
  }),
});

const candidateIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(SHORTS_MAX_SELECTED_CANDIDATES)
  .superRefine((candidateIds, context) => {
    const seen = new Set<string>();
    for (const [index, candidateId] of candidateIds.entries()) {
      if (seen.has(candidateId)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "candidate_ids must not contain duplicates",
        });
      }
      seen.add(candidateId);
    }
  });

/**
 * Input of PATCH /api/shorts/projects/[projectId]. The persisted settings
 * are parsed as a strict allow-listed production profile so the worker sees
 * the exact options shown to the creator and nothing else.
 */
export const selectShortsCandidatesSchema = z.strictObject({
  candidate_ids: candidateIdsSchema,
  production_profile: productionProfileSchema,
});

export type SelectShortsCandidatesInput = z.infer<
  typeof selectShortsCandidatesSchema
>;

/**
 * Only this bounded profile is persisted with selected candidates. Provider
 * prompts, raw transcripts, refresh tokens, and untrusted free-form values
 * are deliberately absent.
 */
export type ShortsProductionProfile = z.infer<typeof productionProfileSchema>;
