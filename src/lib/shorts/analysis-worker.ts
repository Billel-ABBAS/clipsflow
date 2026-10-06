// ============================================================================
// ClipsFlow Shorts — one fenced long-form analysis job
// ============================================================================

import { unlink } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  assertLongformEpisodeDuration,
  buildLongformAnalysisPlan,
  normalizeLongformTranscriptWords,
  rankShortsMomentsWithVisualScores,
  SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS,
} from "@/lib/clips/longform-analysis";
import type { WordTimestamp } from "@/lib/clips/whisper";
import {
  analyzeLongformCandidates,
  assertLongformOpenAIAvailable,
  type LongformOpenAIEnvironment,
} from "./longform-openai";
import {
  analyzeShortsVisualFrames,
  resolveShortsVisualConfig,
  type ShortsVisualEnvironment,
  type ShortsVisualSummary,
} from "./visual-analysis";
import {
  runJevShadowRanking,
  runJevShadowRankingWithConsent,
} from "./jev-shadow";
import {
  buildLongformAudioChunkRanges,
  downloadLongformSource,
  extractCandidateVisualFrames,
  extractLongformAudioChunk,
  probeLongformMedia,
  resolveLongformSourceUrl,
  type LongformSourceEpisode,
} from "./analysis-media";

const DEFAULT_ANALYSIS_LEASE_SECONDS = 1_800;
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_TRANSCRIPT_WORDS = 100_000;

export type ShortsAnalysisWorkerResult =
  | { kind: "idle" }
  | { kind: "completed" | "failed" | "stale"; jobId: string };

interface AnalysisLeaseJob {
  id: string;
  project_id: string;
  user_id: string;
  episode_id: string;
  status: "processing";
  attempt_count: number;
  lease_token: string;
}

interface AnalysisProject {
  id: string;
  user_id: string;
  episode_id: string;
  analysis_mode: "audio" | "audio_video";
  user_instructions: string;
  jev_shadow_consent: boolean;
  status: "transcribing" | "analyzing";
  source_duration_seconds: number | null;
}

export interface ShortsAnalysisWorkerEnvironment
  extends LongformOpenAIEnvironment, ShortsVisualEnvironment {
  CLIPS_FORCE_OPENAI_WHISPER?: string;
  GROQ_API_KEY?: string;
  SHORTS_ANALYSIS_WORKER_ENABLED?: string;
}

export interface ShortsAnalysisWorkerDependencies {
  environment?: ShortsAnalysisWorkerEnvironment;
  resolveSource?: typeof resolveLongformSourceUrl;
  downloadSource?: typeof downloadLongformSource;
  probeMedia?: typeof probeLongformMedia;
  extractAudioChunk?: typeof extractLongformAudioChunk;
  transcribe?: (
    sourceUrl: string,
    audioPath: string,
  ) => Promise<{
    words: WordTimestamp[];
    detectedLanguage: string;
    model: string;
  }>;
  analyzeCandidates?: typeof analyzeLongformCandidates;
  rankWithJev?: typeof runJevShadowRanking;
  extractVisualFrames?: typeof extractCandidateVisualFrames;
  analyzeVisualFrames?: typeof analyzeShortsVisualFrames;
}

class AnalysisLeaseLost extends Error {
  constructor() {
    super("analysis_lease_lost");
    this.name = "AnalysisLeaseLost";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function firstRow(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value))
    return value.length === 1 ? asRecord(value[0]) : null;
  return asRecord(value);
}

function parseClaim(value: unknown): AnalysisLeaseJob | null {
  const row = firstRow(value);
  if (!row) return null;
  if (
    !isUuid(row.id) ||
    !isUuid(row.project_id) ||
    !isUuid(row.user_id) ||
    !isUuid(row.episode_id) ||
    row.status !== "processing" ||
    typeof row.attempt_count !== "number" ||
    !Number.isInteger(row.attempt_count) ||
    !isUuid(row.lease_token)
  ) {
    return null;
  }
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    episode_id: row.episode_id,
    status: "processing",
    attempt_count: row.attempt_count,
    lease_token: row.lease_token,
  };
}

function parseProject(value: unknown): AnalysisProject | null {
  const row = asRecord(value);
  if (
    !row ||
    !isUuid(row.id) ||
    !isUuid(row.user_id) ||
    !isUuid(row.episode_id) ||
    (row.analysis_mode !== "audio" && row.analysis_mode !== "audio_video") ||
    typeof row.user_instructions !== "string" ||
    typeof row.jev_shadow_consent !== "boolean" ||
    (row.status !== "transcribing" && row.status !== "analyzing") ||
    (row.source_duration_seconds !== null &&
      (typeof row.source_duration_seconds !== "number" ||
        !Number.isInteger(row.source_duration_seconds)))
  ) {
    return null;
  }
  return {
    id: row.id,
    user_id: row.user_id,
    episode_id: row.episode_id,
    analysis_mode: row.analysis_mode,
    user_instructions: row.user_instructions,
    jev_shadow_consent: row.jev_shadow_consent,
    status: row.status,
    source_duration_seconds: row.source_duration_seconds,
  };
}

function parseEpisode(value: unknown): LongformSourceEpisode | null {
  const row = asRecord(value);
  if (
    !row ||
    !isUuid(row.id) ||
    !isUuid(row.user_id) ||
    (row.source_type !== "upload" && row.source_type !== "url") ||
    (row.source_url !== null && typeof row.source_url !== "string") ||
    (row.source_storage_path !== null &&
      typeof row.source_storage_path !== "string") ||
    typeof row.status !== "string"
  ) {
    return null;
  }
  return {
    id: row.id,
    user_id: row.user_id,
    source_type: row.source_type,
    source_url: row.source_url,
    source_storage_path: row.source_storage_path,
    status: row.status,
  };
}

function boolResult(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return Array.isArray(value) && value.length === 1 && value[0] === true;
}

/** Merge overlapping transcription chunks into absolute source timestamps. */
export function mergeLongformTranscriptionChunks(
  chunks: readonly {
    startSeconds: number;
    skipLeadingSeconds: number;
    words: readonly WordTimestamp[];
  }[],
): WordTimestamp[] {
  const merged: WordTimestamp[] = [];
  for (const chunk of chunks) {
    if (
      !Number.isFinite(chunk.startSeconds) ||
      chunk.startSeconds < 0 ||
      !Number.isFinite(chunk.skipLeadingSeconds) ||
      chunk.skipLeadingSeconds < 0
    ) {
      continue;
    }
    for (const word of chunk.words) {
      if (
        !word ||
        typeof word.text !== "string" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < chunk.skipLeadingSeconds ||
        word.end <= word.start
      ) {
        continue;
      }
      merged.push({
        text: word.text.normalize("NFKC").trim(),
        start: Math.round((chunk.startSeconds + word.start) * 1_000) / 1_000,
        end: Math.round((chunk.startSeconds + word.end) * 1_000) / 1_000,
      });
    }
  }
  return normalizeLongformTranscriptWords(merged);
}

function resolveTranscriptionAvailability(
  environment: ShortsAnalysisWorkerEnvironment,
): void {
  if (environment.CLIPS_AI_BUDGET_AUTHORIZED !== "true") {
    throw new Error("paid_ai_not_authorized");
  }
  const forceOpenAi = environment.CLIPS_FORCE_OPENAI_WHISPER === "1";
  const hasTranscriptionKey = forceOpenAi
    ? Boolean(environment.OPENAI_API_KEY?.trim())
    : Boolean(
        environment.GROQ_API_KEY?.trim() || environment.OPENAI_API_KEY?.trim(),
      );
  if (!hasTranscriptionKey) throw new Error("transcription_unavailable");
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known = new Set([
    "paid_ai_not_authorized",
    "transcription_unavailable",
    "source_unavailable",
    "source_url_rejected",
    "source_too_large",
    "source_download_timeout",
    "source_download_failed",
    "source_download_invalid_size",
    "source_media_type_invalid",
    "source_duration_probe_failed",
    "episode_duration_out_of_range",
    "source_visual_track_required",
    "no_speech_detected",
    "transcription_failed",
    "longform_analysis_unavailable",
    "longform_analysis_provider_failed",
    "longform_analysis_invalid_response",
    "visual_analysis_disabled",
    "visual_analysis_unavailable",
    "visual_analysis_provider_failed",
    "visual_analysis_invalid_response",
    "analysis_lease_lost",
    "analysis_quota_exceeded",
    "analysis_quota_adjustment_unavailable",
  ]);
  if (known.has(message)) return message;
  if (message.startsWith("shorts_audio_extract"))
    return "audio_extraction_failed";
  if (message.startsWith("shorts_media_probe")) return "source_probe_failed";
  if (message.startsWith("shorts_visual"))
    return "visual_frame_extraction_failed";
  return "analysis_failed";
}

function chooseLanguage(languageCounts: ReadonlyMap<string, number>): string {
  return (
    [...languageCounts.entries()]
      .filter(([language]) => language !== "unknown")
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0]?.[0]
      ?.slice(0, 32) ?? "unknown"
  );
}

async function transcribeChunk(
  sourceUrl: string,
  audioPath: string,
): Promise<{
  words: WordTimestamp[];
  detectedLanguage: string;
  model: string;
}> {
  const { transcribeWithWhisper } = await import("@/lib/clips/whisper");
  return transcribeWithWhisper(sourceUrl, undefined, undefined, audioPath);
}

async function getProjectAndEpisode(
  admin: SupabaseClient,
  job: AnalysisLeaseJob,
): Promise<{ project: AnalysisProject; episode: LongformSourceEpisode }> {
  const [
    { data: projectData, error: projectError },
    { data: episodeData, error: episodeError },
  ] = await Promise.all([
    admin
      .from("shorts_projects")
      .select(
        "id,user_id,episode_id,analysis_mode,user_instructions,jev_shadow_consent,status,source_duration_seconds",
      )
      .eq("id", job.project_id)
      .eq("user_id", job.user_id)
      .maybeSingle(),
    admin
      .from("episodes")
      .select("id,user_id,source_type,source_url,source_storage_path,status")
      .eq("id", job.episode_id)
      .eq("user_id", job.user_id)
      .maybeSingle(),
  ]);
  if (projectError || episodeError)
    throw new Error("analysis_data_unavailable");
  const project = parseProject(projectData);
  const episode = parseEpisode(episodeData);
  if (
    !project ||
    !episode ||
    project.id !== job.project_id ||
    project.user_id !== job.user_id ||
    project.episode_id !== job.episode_id ||
    episode.id !== job.episode_id ||
    episode.user_id !== job.user_id ||
    episode.status !== "ready"
  ) {
    throw new Error("analysis_data_unavailable");
  }
  return { project, episode };
}

function parseRenewal(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value) && value.length === 1) return value[0] === true;
  return false;
}

async function processClaimedJob(
  admin: SupabaseClient,
  job: AnalysisLeaseJob,
  dependencies: ShortsAnalysisWorkerDependencies,
): Promise<ShortsAnalysisWorkerResult> {
  const environment =
    dependencies.environment ??
    (process.env as ShortsAnalysisWorkerEnvironment);
  let leaseLost = false;
  let heartbeatBusy = false;
  let heartbeatTask: Promise<void> = Promise.resolve();
  const heartbeatTimer = setInterval(() => {
    if (heartbeatBusy || leaseLost) return;
    heartbeatBusy = true;
    heartbeatTask = Promise.resolve(
      admin.rpc("shorts_renew_analysis_lease", {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_lease_seconds: DEFAULT_ANALYSIS_LEASE_SECONDS,
      }),
    )
      .then(({ data, error }) => {
        if (error || !parseRenewal(data)) leaseLost = true;
      })
      .catch(() => {
        leaseLost = true;
      })
      .finally(() => {
        heartbeatBusy = false;
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  let sourcePath: string | null = null;
  try {
    const ensureLease = (): void => {
      if (leaseLost) throw new AnalysisLeaseLost();
    };

    const { project, episode } = await getProjectAndEpisode(admin, job);
    resolveTranscriptionAvailability(environment);
    assertLongformOpenAIAvailable(environment);
    if (project.analysis_mode === "audio_video") {
      resolveShortsVisualConfig(environment);
    }
    ensureLease();

    const source = await (
      dependencies.resolveSource ?? resolveLongformSourceUrl
    )(admin, episode);
    const downloaded = await (
      dependencies.downloadSource ?? downloadLongformSource
    )(source.url, source.allowedHosts);
    sourcePath = downloaded.path;

    const media = await (dependencies.probeMedia ?? probeLongformMedia)(
      sourcePath,
    );
    const durationSeconds = assertLongformEpisodeDuration(
      Math.round(media.durationSeconds),
    );
    if (project.analysis_mode === "audio_video" && !media.hasVideo) {
      throw new Error("source_visual_track_required");
    }
    ensureLease();

    let quotaAdjustment;
    try {
      quotaAdjustment = await admin.rpc("shorts_adjust_analysis_quota", {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_actual_duration_seconds: durationSeconds,
      });
    } catch {
      throw new Error("analysis_quota_adjustment_unavailable");
    }
    ensureLease();
    if (quotaAdjustment.error) {
      throw new Error("analysis_quota_adjustment_unavailable");
    }
    if (!boolResult(quotaAdjustment.data)) {
      throw new Error("analysis_quota_exceeded");
    }

    const chunkRanges = buildLongformAudioChunkRanges(media.durationSeconds);
    const transcriptChunks: Array<{
      startSeconds: number;
      skipLeadingSeconds: number;
      words: WordTimestamp[];
    }> = [];
    const languageCounts = new Map<string, number>();
    const transcriptionModels = new Set<string>();
    for (const range of chunkRanges) {
      ensureLease();
      const chunkPath = await (
        dependencies.extractAudioChunk ?? extractLongformAudioChunk
      )(sourcePath, range.start_seconds, range.end_seconds, job.id);
      try {
        const result = await (dependencies.transcribe ?? transcribeChunk)(
          source.url,
          chunkPath,
        );
        transcriptChunks.push({
          startSeconds: range.start_seconds,
          skipLeadingSeconds: range.skip_leading_seconds,
          words: result.words,
        });
        const language =
          result.detectedLanguage.trim().toLowerCase() || "unknown";
        languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
        transcriptionModels.add(result.model);
      } catch {
        throw new Error("transcription_failed");
      } finally {
        await unlink(chunkPath).catch(() => {});
      }
      ensureLease();
    }

    const transcriptWords = mergeLongformTranscriptionChunks(transcriptChunks);
    if (transcriptWords.length === 0) throw new Error("no_speech_detected");
    if (transcriptWords.length > MAX_TRANSCRIPT_WORDS) {
      throw new Error("transcript_too_large");
    }
    const transcriptText = transcriptWords.map(({ text }) => text).join(" ");
    const transcriptLanguage = chooseLanguage(languageCounts);
    const transcriptionModel = [...transcriptionModels].slice(0, 4).join(",");
    const analysisPlan = buildLongformAnalysisPlan({
      episodeDurationSeconds: media.durationSeconds,
      transcriptWords,
      userInstructions: project.user_instructions,
    });
    if (analysisPlan.candidate_windows.length === 0) {
      throw new Error("no_speech_detected");
    }
    if (analysisPlan.candidate_windows.length > 160) {
      throw new Error("candidate_catalogue_too_large");
    }

    ensureLease();
    const { data: analyzingData, error: analyzingError } = await admin.rpc(
      "shorts_mark_analysis_analyzing",
      { p_job_id: job.id, p_lease_token: job.lease_token },
    );
    if (analyzingError || !boolResult(analyzingData))
      throw new AnalysisLeaseLost();

    const analysis = await (
      dependencies.analyzeCandidates ?? analyzeLongformCandidates
    )(
      {
        episodeDurationSeconds: durationSeconds,
        creatorInstructions: project.user_instructions,
        candidateWindows: analysisPlan.candidate_windows,
      },
      { environment },
    );
    ensureLease();

    const windowById = new Map(
      analysisPlan.candidate_windows.map((candidate) => [
        candidate.id,
        candidate,
      ]),
    );
    const jevCandidates = analysis.moments.map((moment, index) => {
      const candidate = windowById.get(moment.candidate_id);
      if (!candidate) throw new Error("longform_analysis_invalid_response");
      return {
        id: candidate.id,
        startSeconds: candidate.start_seconds,
        endSeconds: candidate.end_seconds,
        transcript: candidate.transcript,
        baselineRank: index + 1,
      };
    });
    const jev = await runJevShadowRankingWithConsent(
      {
        creatorInstructions: project.user_instructions,
        candidates: jevCandidates,
      },
      project.jev_shadow_consent,
      { environment },
      dependencies.rankWithJev ?? runJevShadowRanking,
    );

    let visualModel: string | null = null;
    let visualSummaryById = new Map<string, string>();
    let visualScoreById = new Map<string, number>();
    if (project.analysis_mode === "audio_video") {
      ensureLease();
      const selectedWindows = analysis.moments.map((moment) => {
        const window = analysisPlan.candidate_windows.find(
          (candidate) => candidate.id === moment.candidate_id,
        );
        if (!window) throw new Error("longform_analysis_invalid_response");
        return window;
      });
      const frames = await (
        dependencies.extractVisualFrames ?? extractCandidateVisualFrames
      )(sourcePath, selectedWindows);
      const visualSummaries: ShortsVisualSummary[] = await (
        dependencies.analyzeVisualFrames ?? analyzeShortsVisualFrames
      )(frames, { environment });
      visualSummaryById = new Map(
        visualSummaries.map(({ candidateId, summary }) => [
          candidateId,
          summary,
        ]),
      );
      visualScoreById = new Map(
        visualSummaries.map(({ candidateId, visualScore }) => [
          candidateId,
          visualScore,
        ]),
      );
      visualModel = resolveShortsVisualConfig(environment).model;
      ensureLease();
    }

    const rankedMoments =
      project.analysis_mode === "audio_video"
        ? rankShortsMomentsWithVisualScores(analysis.moments, visualScoreById)
        : analysis.moments;
    const finalScoreById = new Map(
      rankedMoments.map((moment) => [moment.candidate_id, moment.score]),
    );

    const candidates = rankedMoments.map((moment, index) => {
      const window = windowById.get(moment.candidate_id);
      if (!window) throw new Error("longform_analysis_invalid_response");
      return {
        rank: index + 1,
        start_seconds: Math.round(window.start_seconds),
        end_seconds: Math.round(window.end_seconds),
        score: moment.score,
        hook: moment.hook.slice(0, 280),
        title: moment.proposed_title.slice(0, 160),
        rationale: moment.rationale.slice(0, 1_200),
        transcript_excerpt: window.transcript.slice(0, 6_000),
        music_mood: moment.music_mood,
        motion_direction: moment.motion_direction.slice(0, 160),
        visual_summary: visualSummaryById.get(moment.candidate_id) ?? null,
        production_profile: {},
      };
    });

    const jevTelemetry = {
      status: jev.status,
      model: jev.model,
      input_tokens: jev.inputTokens,
      output_tokens: jev.outputTokens,
      // The shadow order is private measurement data. It is never used when
      // writing candidate ranks, scores, or user-visible ordering.
      results:
        jev.status === "shadow_complete"
          ? jev.results.map((result) => ({
              candidate_id: result.candidateId,
              baseline_rank: result.baselineRank,
              shadow_rank: result.shadowRank,
              composite_score: result.compositeScore,
              confidence: result.confidence,
              dimensions: result.dimensions,
            }))
          : [],
    };
    const analysisPayload = {
      version: "shorts-analysis-payload-v1",
      summary: analysis.summary,
      source_duration_seconds: durationSeconds,
      candidate_window_count: analysisPlan.candidate_windows.length,
      transcription_chunk_count: chunkRanges.length,
      visual_ranking:
        project.analysis_mode === "audio_video"
          ? {
              version: "shorts-audio-visual-ranking-v1",
              audio_weight: SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS.audio,
              visual_weight: SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS.visual,
              candidates: analysis.moments.map((moment) => ({
                candidate_id: moment.candidate_id,
                audio_score: moment.score,
                visual_score: visualScoreById.get(moment.candidate_id) ?? null,
                final_score:
                  finalScoreById.get(moment.candidate_id) ?? moment.score,
              })),
            }
          : null,
      jev_shadow: jevTelemetry,
    };

    ensureLease();
    const { data: completedData, error: completedError } = await admin.rpc(
      "shorts_complete_analysis_job",
      {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_transcript_language: transcriptLanguage,
        p_transcription_model: transcriptionModel,
        p_analysis_model:
          environment.CLIPS_LONGFORM_ANALYSIS_MODEL || "gpt-5.4-mini",
        p_vision_model: visualModel,
        p_analysis_payload: analysisPayload,
        p_source_duration_seconds: durationSeconds,
        p_transcript_text: transcriptText,
        p_transcript_segments: transcriptWords,
        p_candidates: candidates,
      },
    );
    if (completedError) throw new Error("analysis_persistence_failed");
    if (!boolResult(completedData)) return { kind: "stale", jobId: job.id };
    return { kind: "completed", jobId: job.id };
  } catch (error) {
    if (error instanceof AnalysisLeaseLost || leaseLost) {
      return { kind: "stale", jobId: job.id };
    }
    const errorCode = safeFailureCode(error);
    console.error(
      JSON.stringify({
        level: "error",
        source: "shorts-analysis-worker",
        message: "analysis_job_failed",
        job_id: job.id,
        error_code: errorCode,
      }),
    );
    await Promise.resolve(
      admin.rpc("shorts_fail_analysis_job", {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_error_message: errorCode,
      }),
    ).catch(() => null);
    return { kind: "failed", jobId: job.id };
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatTask.catch(() => {});
    if (sourcePath) await unlink(sourcePath).catch(() => {});
  }
}

/** Claim and process no more than one analysis job per worker invocation. */
export async function processOneShortsAnalysisJob(
  admin: SupabaseClient,
  dependencies: ShortsAnalysisWorkerDependencies = {},
): Promise<ShortsAnalysisWorkerResult> {
  const environment =
    dependencies.environment ??
    (process.env as ShortsAnalysisWorkerEnvironment);
  if (
    environment.SHORTS_ANALYSIS_WORKER_ENABLED !== "true" &&
    environment.SHORTS_ANALYSIS_WORKER_ENABLED !== "1"
  ) {
    return { kind: "idle" };
  }
  // Do not lease a user job until its required paid providers are configured.
  // This preserves queued work while credentials or budget approval are being
  // provisioned, instead of burning retries and marking it failed.
  try {
    resolveTranscriptionAvailability(environment);
    assertLongformOpenAIAvailable(environment);
  } catch (error) {
    console.info(
      JSON.stringify({
        level: "info",
        source: "shorts-analysis-worker",
        message: "worker_prerequisites_unavailable",
        error_code: safeFailureCode(error),
      }),
    );
    return { kind: "idle" };
  }
  let claimResult;
  try {
    claimResult = await admin.rpc("shorts_claim_analysis_job", {
      p_lease_seconds: DEFAULT_ANALYSIS_LEASE_SECONDS,
    });
  } catch {
    throw new Error("analysis_queue_unavailable");
  }
  if (claimResult.error) throw new Error("analysis_queue_unavailable");
  const job = parseClaim(claimResult.data);
  if (!job) {
    const row = firstRow(claimResult.data);
    if (!row) return { kind: "idle" };
    console.error(
      JSON.stringify({
        level: "error",
        source: "shorts-analysis-worker",
        message: "analysis_claim_invalid",
      }),
    );
    return { kind: "idle" };
  }
  return processClaimedJob(admin, job, { ...dependencies, environment });
}
