// ============================================================================
// ClipsFlow — Long-form analysis domain primitives
// ============================================================================
// This module intentionally contains no network, database, or provider call.
// It turns a bounded long-form transcript into deterministic, auditable input
// for a later AI analysis job, then strictly validates that job's response.
// ============================================================================

import { z } from "zod";

import { shortsMusicMoodSchema } from "@/lib/shorts/project-contract";
import {
  SHORTS_MAX_SOURCE_DURATION_SECONDS,
  SHORTS_MIN_SOURCE_DURATION_SECONDS,
} from "@/lib/shorts/source-duration";
import type { WordTimestamp } from "./whisper";

/** Long-form analysis accepts sources from one minute through four hours. */
export const LONGFORM_MIN_DURATION_SECONDS = SHORTS_MIN_SOURCE_DURATION_SECONDS;
export const LONGFORM_MAX_DURATION_SECONDS = SHORTS_MAX_SOURCE_DURATION_SECONDS;

/** Provider-friendly transcript windows: 10 minutes with 30 seconds overlap. */
export const DEFAULT_LONGFORM_CHUNK_DURATION_SECONDS = 10 * 60;
export const DEFAULT_LONGFORM_CHUNK_OVERLAP_SECONDS = 30;

/** Deterministic Short candidates: 60 seconds with 15 seconds overlap. */
export const DEFAULT_CANDIDATE_WINDOW_SECONDS = 60;
export const DEFAULT_CANDIDATE_WINDOW_OVERLAP_SECONDS = 15;
export const DEFAULT_CANDIDATE_MIN_DURATION_SECONDS = 15;
export const SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS = {
  audio: 0.8,
  visual: 0.2,
} as const;

export const MAX_LONGFORM_ANALYSIS_INSTRUCTIONS_LENGTH = 1_200;
export const LONGFORM_ANALYSIS_RESPONSE_VERSION =
  "longform-analysis-v1" as const;

export const DEFAULT_LONGFORM_ANALYSIS_INSTRUCTIONS =
  "Identify the most compelling, self-contained moments for short-form video. Prefer clear hooks, useful insight, emotion, or a memorable story beat.";

export type LongformAnalysisErrorCode =
  | "episode_duration_out_of_range"
  | "invalid_chunk_options"
  | "invalid_candidate_options"
  | "invalid_ai_response";

/** A stable error shape for routes/workers to map to a safe public response. */
export class LongformAnalysisValidationError extends Error {
  constructor(
    public readonly code: LongformAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LongformAnalysisValidationError";
  }
}

export type LongformTranscriptWord = Readonly<{
  text: string;
  start: number;
  end: number;
}>;

export type LongformTranscriptChunk = Readonly<{
  id: string;
  index: number;
  start_seconds: number;
  end_seconds: number;
  words: readonly LongformTranscriptWord[];
  transcript: string;
}>;

export type LongformCandidateWindow = Readonly<{
  id: string;
  index: number;
  start_seconds: number;
  end_seconds: number;
  word_count: number;
  transcript: string;
}>;

export interface LongformTranscriptChunkingOptions {
  episodeDurationSeconds: number;
  chunkDurationSeconds?: number;
  overlapSeconds?: number;
}

export interface LongformCandidateWindowOptions {
  episodeDurationSeconds: number;
  windowDurationSeconds?: number;
  overlapSeconds?: number;
  minDurationSeconds?: number;
}

export interface BuildLongformAnalysisPlanInput {
  episodeDurationSeconds: number;
  transcriptWords: readonly WordTimestamp[];
  userInstructions?: unknown;
  chunkDurationSeconds?: number;
  chunkOverlapSeconds?: number;
  candidateWindowSeconds?: number;
  candidateOverlapSeconds?: number;
  candidateMinDurationSeconds?: number;
}

/** Input assembled locally before a provider-specific analysis step. */
export interface LongformAnalysisPlan {
  episode_duration_seconds: number;
  user_instructions: string;
  transcript_chunks: readonly LongformTranscriptChunk[];
  candidate_windows: readonly LongformCandidateWindow[];
}

function normalizeWhitespace(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function roundedSeconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function transcriptText(words: readonly LongformTranscriptWord[]): string {
  return words.map((word) => word.text).join(" ");
}

function intervalWords(
  words: readonly LongformTranscriptWord[],
  startSeconds: number,
  endSeconds: number,
): LongformTranscriptWord[] {
  return words.filter(
    (word) => word.end > startSeconds && word.start < endSeconds,
  );
}

function requireFinitePositive(
  value: number,
  code: "invalid_chunk_options" | "invalid_candidate_options",
  field: string,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new LongformAnalysisValidationError(
      code,
      `${field} must be a finite number greater than zero`,
    );
  }
  return value;
}

function resolveWindowOptions(
  length: number | undefined,
  overlap: number | undefined,
  defaultLength: number,
  defaultOverlap: number,
  code: "invalid_chunk_options" | "invalid_candidate_options",
  lengthField: string,
): { length: number; overlap: number } {
  const resolvedLength = requireFinitePositive(
    length ?? defaultLength,
    code,
    lengthField,
  );
  const resolvedOverlap = overlap ?? defaultOverlap;
  if (
    !Number.isFinite(resolvedOverlap) ||
    resolvedOverlap < 0 ||
    resolvedOverlap >= resolvedLength
  ) {
    throw new LongformAnalysisValidationError(
      code,
      `overlapSeconds must be a finite number from zero to less than ${lengthField}`,
    );
  }
  return { length: resolvedLength, overlap: resolvedOverlap };
}

function slidingRanges(
  episodeDurationSeconds: number,
  lengthSeconds: number,
  overlapSeconds: number,
  minDurationSeconds: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;

  while (start < episodeDurationSeconds) {
    const end = Math.min(episodeDurationSeconds, start + lengthSeconds);
    if (end - start >= minDurationSeconds) {
      ranges.push({
        start: roundedSeconds(start),
        end: roundedSeconds(end),
      });
    }
    if (end >= episodeDurationSeconds) break;

    const nextStart = roundedSeconds(end - overlapSeconds);
    // `overlap < length` is validated above. This guard still makes the loop
    // fail closed if an unusual floating-point input cannot make progress.
    if (nextStart <= start) break;
    start = nextStart;
  }

  return ranges;
}

/** True only for finite durations within the product's long-form range. */
export function isLongformEpisodeDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= LONGFORM_MIN_DURATION_SECONDS &&
    value <= LONGFORM_MAX_DURATION_SECONDS
  );
}

/**
 * Enforce the one-minute–four-hour product contract before spending AI budget.
 * Bounds are inclusive so both endpoints are accepted.
 */
export function assertLongformEpisodeDuration(value: unknown): number {
  if (isLongformEpisodeDuration(value)) return value;
  throw new LongformAnalysisValidationError(
    "episode_duration_out_of_range",
    `episode duration must be between ${LONGFORM_MIN_DURATION_SECONDS} and ${LONGFORM_MAX_DURATION_SECONDS} seconds`,
  );
}

/** Blend transcript and visual evidence while keeping audio as the primary signal. */
export function combineShortsAudioVisualScore(
  audioScore: number,
  visualScore: number,
): number {
  if (
    !Number.isFinite(audioScore) ||
    audioScore < 0 ||
    audioScore > 100 ||
    !Number.isFinite(visualScore) ||
    visualScore < 0 ||
    visualScore > 100
  ) {
    throw new LongformAnalysisValidationError(
      "invalid_ai_response",
      "audio and visual scores must be between zero and one hundred",
    );
  }
  return Math.round(
    audioScore * SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS.audio +
      visualScore * SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS.visual,
  );
}

/** Re-rank transcript-selected moments with visual evidence, stably on ties. */
export function rankShortsMomentsWithVisualScores<
  T extends { candidate_id: string; score: number },
>(moments: readonly T[], visualScores: ReadonlyMap<string, number>): T[] {
  return moments
    .map((moment, index) => ({
      moment,
      index,
      score: visualScores.has(moment.candidate_id)
        ? combineShortsAudioVisualScore(
            moment.score,
            visualScores.get(moment.candidate_id)!,
          )
        : moment.score,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ moment, score }) => ({ ...moment, score }));
}

/**
 * Canonicalize optional free-form user direction for a later provider prompt.
 * Missing, blank, or non-string input uses a safe product default; control
 * characters and repeated whitespace are removed and the result is bounded.
 */
export function normalizeLongformAnalysisInstructions(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_LONGFORM_ANALYSIS_INSTRUCTIONS;

  const normalized = normalizeWhitespace(value);
  if (!normalized) return DEFAULT_LONGFORM_ANALYSIS_INSTRUCTIONS;
  return normalized.slice(0, MAX_LONGFORM_ANALYSIS_INSTRUCTIONS_LENGTH);
}

/**
 * Drop malformed timestamp records, canonicalize text, and stably sort by
 * timestamp. The source array is never mutated.
 */
export function normalizeLongformTranscriptWords(
  transcriptWords: readonly WordTimestamp[],
): LongformTranscriptWord[] {
  const normalized: Array<LongformTranscriptWord & { sourceIndex: number }> =
    [];

  for (const [sourceIndex, candidate] of transcriptWords.entries()) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const text =
      typeof record.text === "string" ? normalizeWhitespace(record.text) : "";
    const start = record.start;
    const end = record.end;
    if (
      !text ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    ) {
      continue;
    }
    normalized.push({ text, start, end, sourceIndex });
  }

  normalized.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.sourceIndex - right.sourceIndex,
  );

  return normalized.map(({ text, start, end }) => ({ text, start, end }));
}

/**
 * Split a transcript across the full episode timeline. Each adjacent range
 * overlaps by the configured number of seconds, preserving words that cross a
 * boundary so an AI reviewer never loses the sentence transition.
 */
export function chunkLongformTranscript(
  transcriptWords: readonly WordTimestamp[],
  options: LongformTranscriptChunkingOptions,
): LongformTranscriptChunk[] {
  const episodeDurationSeconds = assertLongformEpisodeDuration(
    options.episodeDurationSeconds,
  );
  const { length: chunkDurationSeconds, overlap: overlapSeconds } =
    resolveWindowOptions(
      options.chunkDurationSeconds,
      options.overlapSeconds,
      DEFAULT_LONGFORM_CHUNK_DURATION_SECONDS,
      DEFAULT_LONGFORM_CHUNK_OVERLAP_SECONDS,
      "invalid_chunk_options",
      "chunkDurationSeconds",
    );
  const words = normalizeLongformTranscriptWords(transcriptWords).filter(
    (word) =>
      word.start < episodeDurationSeconds && word.end <= episodeDurationSeconds,
  );

  return slidingRanges(
    episodeDurationSeconds,
    chunkDurationSeconds,
    overlapSeconds,
    0,
  ).map(({ start, end }, index) => {
    const chunkWords = intervalWords(words, start, end);
    return {
      id: `chunk-${String(index + 1).padStart(3, "0")}`,
      index,
      start_seconds: start,
      end_seconds: end,
      words: chunkWords,
      transcript: transcriptText(chunkWords),
    };
  });
}

/**
 * Produce fixed, chronological candidate windows without calling a model.
 * Empty/silent ranges are omitted; every returned ID is stable for identical
 * input and is later used instead of trusting model-invented timestamps.
 */
export function buildDeterministicCandidateWindows(
  transcriptWords: readonly WordTimestamp[],
  options: LongformCandidateWindowOptions,
): LongformCandidateWindow[] {
  const episodeDurationSeconds = assertLongformEpisodeDuration(
    options.episodeDurationSeconds,
  );
  const { length: windowDurationSeconds, overlap: overlapSeconds } =
    resolveWindowOptions(
      options.windowDurationSeconds,
      options.overlapSeconds,
      DEFAULT_CANDIDATE_WINDOW_SECONDS,
      DEFAULT_CANDIDATE_WINDOW_OVERLAP_SECONDS,
      "invalid_candidate_options",
      "windowDurationSeconds",
    );
  const minDurationSeconds = requireFinitePositive(
    options.minDurationSeconds ?? DEFAULT_CANDIDATE_MIN_DURATION_SECONDS,
    "invalid_candidate_options",
    "minDurationSeconds",
  );
  if (minDurationSeconds > windowDurationSeconds) {
    throw new LongformAnalysisValidationError(
      "invalid_candidate_options",
      "minDurationSeconds must not exceed windowDurationSeconds",
    );
  }

  const words = normalizeLongformTranscriptWords(transcriptWords).filter(
    (word) =>
      word.start < episodeDurationSeconds && word.end <= episodeDurationSeconds,
  );
  const candidates: LongformCandidateWindow[] = [];

  for (const { start, end } of slidingRanges(
    episodeDurationSeconds,
    windowDurationSeconds,
    overlapSeconds,
    minDurationSeconds,
  )) {
    const candidateWords = intervalWords(words, start, end);
    if (candidateWords.length === 0) continue;
    const index = candidates.length;
    candidates.push({
      id: `candidate-${String(index + 1).padStart(3, "0")}`,
      index,
      start_seconds: start,
      end_seconds: end,
      word_count: candidateWords.length,
      transcript: transcriptText(candidateWords),
    });
  }

  return candidates;
}

/** Assemble all deterministic context a future analysis worker may send. */
export function buildLongformAnalysisPlan(
  input: BuildLongformAnalysisPlanInput,
): LongformAnalysisPlan {
  const episodeDurationSeconds = assertLongformEpisodeDuration(
    input.episodeDurationSeconds,
  );
  return {
    episode_duration_seconds: episodeDurationSeconds,
    user_instructions: normalizeLongformAnalysisInstructions(
      input.userInstructions,
    ),
    transcript_chunks: chunkLongformTranscript(input.transcriptWords, {
      episodeDurationSeconds,
      chunkDurationSeconds: input.chunkDurationSeconds,
      overlapSeconds: input.chunkOverlapSeconds,
    }),
    candidate_windows: buildDeterministicCandidateWindows(
      input.transcriptWords,
      {
        episodeDurationSeconds,
        windowDurationSeconds: input.candidateWindowSeconds,
        overlapSeconds: input.candidateOverlapSeconds,
        minDurationSeconds: input.candidateMinDurationSeconds,
      },
    ),
  };
}

const candidateIdPattern = /^candidate-\d{3,}$/u;
const nonEmptyText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);

/** Exact JSON shape a provider must return; unknown fields are rejected. */
export const longformAnalysisResponseSchema = z.strictObject({
  version: z.literal(LONGFORM_ANALYSIS_RESPONSE_VERSION),
  summary: nonEmptyText(1_200),
  moments: z
    .array(
      z.strictObject({
        candidate_id: z.string().regex(candidateIdPattern),
        score: z.number().int().min(0).max(100),
        proposed_title: nonEmptyText(120),
        hook: nonEmptyText(280),
        rationale: nonEmptyText(600),
        music_mood: shortsMusicMoodSchema,
        motion_direction: nonEmptyText(160),
      }),
    )
    .min(1)
    .max(12),
});

export type LongformAnalysisResponse = z.infer<
  typeof longformAnalysisResponseSchema
>;

/**
 * Validate untrusted structured model output against both the fixed schema and
 * the immutable candidate catalogue generated locally. This prevents a model
 * response from inventing timestamps or choosing the same moment twice.
 */
export function parseLongformAnalysisResponse(
  value: unknown,
  candidateWindows: readonly Pick<LongformCandidateWindow, "id">[],
): LongformAnalysisResponse {
  const parsed = longformAnalysisResponseSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
      .join("; ");
    throw new LongformAnalysisValidationError(
      "invalid_ai_response",
      `analysis response does not match the required schema${details ? ` (${details})` : ""}`,
    );
  }

  const candidateIds = new Set(
    candidateWindows.map((candidate) => candidate.id),
  );
  if (
    candidateIds.size === 0 ||
    candidateIds.size !== candidateWindows.length
  ) {
    throw new LongformAnalysisValidationError(
      "invalid_ai_response",
      "candidate catalogue must contain unique IDs before validating analysis output",
    );
  }

  const selectedIds = new Set<string>();
  let previousScore = Number.POSITIVE_INFINITY;
  for (const moment of parsed.data.moments) {
    if (!candidateIds.has(moment.candidate_id)) {
      throw new LongformAnalysisValidationError(
        "invalid_ai_response",
        `analysis response selected an unknown candidate ID: ${moment.candidate_id}`,
      );
    }
    if (selectedIds.has(moment.candidate_id)) {
      throw new LongformAnalysisValidationError(
        "invalid_ai_response",
        `analysis response selected candidate ID more than once: ${moment.candidate_id}`,
      );
    }
    if (moment.score > previousScore) {
      throw new LongformAnalysisValidationError(
        "invalid_ai_response",
        "analysis response moments must be ordered from highest to lowest score",
      );
    }
    selectedIds.add(moment.candidate_id);
    previousScore = moment.score;
  }

  return parsed.data;
}
