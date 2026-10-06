import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalyzeLongformCandidatesInput } from "@/lib/shorts/longform-openai";
import type { JevShadowInput, JevShadowResult } from "./jev-shadow";
import type {
  ShortsVisualFrameSet,
  ShortsVisualSummary,
} from "./visual-analysis";
import {
  mergeLongformTranscriptionChunks,
  processOneShortsAnalysisJob,
} from "./analysis-worker";

const validEnvironment = {
  SHORTS_ANALYSIS_WORKER_ENABLED: "true",
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  OPENAI_API_KEY: "test-openai-key",
  GROQ_API_KEY: "test-groq-key",
} as const;

describe("fenced Shorts analysis worker", () => {
  it("does not claim work when the worker switch is off", async () => {
    const rpc = vi.fn();
    const admin = { rpc } as unknown as SupabaseClient;
    await expect(
      processOneShortsAnalysisJob(admin, {
        environment: { SHORTS_ANALYSIS_WORKER_ENABLED: "false" },
      }),
    ).resolves.toEqual({ kind: "idle" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves paid analysis queued until the budget is authorized", async () => {
    const rpc = vi.fn();
    const admin = { rpc } as unknown as SupabaseClient;
    await expect(
      processOneShortsAnalysisJob(admin, {
        environment: {
          ...validEnvironment,
          CLIPS_AI_BUDGET_AUTHORIZED: "false",
        },
      }),
    ).resolves.toEqual({ kind: "idle" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves paid analysis queued until required provider keys exist", async () => {
    const rpc = vi.fn();
    const admin = { rpc } as unknown as SupabaseClient;
    await expect(
      processOneShortsAnalysisJob(admin, {
        environment: {
          ...validEnvironment,
          OPENAI_API_KEY: "",
        },
      }),
    ).resolves.toEqual({ kind: "idle" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns idle when the fenced queue has no job", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const admin = { rpc } as unknown as SupabaseClient;
    await expect(
      processOneShortsAnalysisJob(admin, {
        environment: validEnvironment,
      }),
    ).resolves.toEqual({ kind: "idle" });
    expect(rpc).toHaveBeenCalledWith("shorts_claim_analysis_job", {
      p_lease_seconds: 1_800,
    });
  });

  it("transcribes a queued long-form project and persists its music and motion recommendations", async () => {
    const jobId = "40000000-0000-4000-8000-000000000001";
    const projectId = "10000000-0000-4000-8000-000000000001";
    const userId = "20000000-0000-4000-8000-000000000001";
    const episodeId = "30000000-0000-4000-8000-000000000001";
    const leaseToken = "50000000-0000-4000-8000-000000000001";
    const completionArguments: Array<Record<string, unknown>> = [];
    const providerOrder: string[] = [];
    const project = {
      id: projectId,
      user_id: userId,
      episode_id: episodeId,
      analysis_mode: "audio",
      user_instructions: "Prefer useful conclusions.",
      jev_shadow_consent: false,
      status: "transcribing",
      source_duration_seconds: 1_200,
    };
    const episode = {
      id: episodeId,
      user_id: userId,
      source_type: "upload",
      source_url: null,
      source_storage_path: `${userId}/shorts/source.mp4`,
      status: "ready",
    };

    const queryFor = (data: unknown) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data, error: null })),
      };
      return query;
    };
    const projectQuery = queryFor(project);
    const episodeQuery = queryFor(episode);
    const from = vi.fn((table: string) => {
      if (table === "shorts_projects") return projectQuery;
      if (table === "episodes") return episodeQuery;
      throw new Error(`unexpected_table:${table}`);
    });
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "shorts_claim_analysis_job") {
        return {
          data: [
            {
              id: jobId,
              project_id: projectId,
              user_id: userId,
              episode_id: episodeId,
              status: "processing",
              attempt_count: 1,
              lease_token: leaseToken,
            },
          ],
          error: null,
        };
      }
      if (name === "shorts_mark_analysis_analyzing") {
        return { data: true, error: null };
      }
      if (name === "shorts_adjust_analysis_quota") {
        providerOrder.push("quota-adjustment");
        return { data: true, error: null };
      }
      if (name === "shorts_complete_analysis_job") {
        completionArguments.push(args ?? {});
        return { data: true, error: null };
      }
      throw new Error(`unexpected_rpc:${name}`);
    });
    const admin = { rpc, from } as unknown as SupabaseClient;
    const rankWithJev = vi.fn(async () => ({
      status: "disabled" as const,
      model: null,
      results: [] as const,
      inputTokens: null,
      outputTokens: null,
    }));
    const result = await processOneShortsAnalysisJob(admin, {
      environment: validEnvironment,
      resolveSource: vi.fn(async () => ({
        url: "https://media.example/episode",
      })),
      downloadSource: vi.fn(async () => ({
        path: "unused-short-source.media",
        bytes: 100,
        contentType: "audio/mpeg",
      })),
      probeMedia: vi.fn(async () => ({
        durationSeconds: 1_200,
        hasVideo: false,
      })),
      extractAudioChunk: vi.fn(
        async (_sourcePath, startSeconds) =>
          `unused-audio-chunk-${startSeconds}.wav`,
      ),
      transcribe: vi.fn(async () => {
        providerOrder.push("transcription");
        return {
          words: [{ text: "sample transcript", start: 20, end: 20.5 }],
          detectedLanguage: "en",
          model: "whisper-test",
        };
      }),
      analyzeCandidates: vi.fn(
        async (input: AnalyzeLongformCandidatesInput) => ({
          version: "longform-analysis-v1" as const,
          summary: "One useful moment.",
          moments: [
            {
              candidate_id: input.candidateWindows[0]!.id,
              score: 91,
              proposed_title: "A useful moment",
              hook: "Here is the key point.",
              rationale: "The transcript provides a complete point.",
              music_mood: "uplifting" as const,
              motion_direction: "Emphasize the conclusion once.",
            },
          ],
        }),
      ),
      rankWithJev,
    });

    expect(result).toEqual({ kind: "completed", jobId });
    expect(rankWithJev).not.toHaveBeenCalled();
    expect(providerOrder[0]).toBe("quota-adjustment");
    expect(
      providerOrder.slice(1).every((step) => step === "transcription"),
    ).toBe(true);
    expect(rpc).toHaveBeenCalledWith("shorts_adjust_analysis_quota", {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_actual_duration_seconds: 1_200,
    });
    expect(completionArguments).toHaveLength(1);
    expect(completionArguments[0]?.p_analysis_model).toBe("gpt-5.4-mini");
    expect(completionArguments[0]?.p_candidates).toEqual([
      expect.objectContaining({
        music_mood: "uplifting",
        motion_direction: "Emphasize the conclusion once.",
      }),
    ]);
  });

  it("ranks audiovisual candidates from visual evidence without applying Jev shadow order", async () => {
    const jobId = "40000000-0000-4000-8000-000000000002";
    const projectId = "10000000-0000-4000-8000-000000000002";
    const userId = "20000000-0000-4000-8000-000000000002";
    const episodeId = "30000000-0000-4000-8000-000000000002";
    const leaseToken = "50000000-0000-4000-8000-000000000002";
    const completionArguments: Array<Record<string, unknown>> = [];
    const project = {
      id: projectId,
      user_id: userId,
      episode_id: episodeId,
      analysis_mode: "audio_video",
      user_instructions: "Prefer useful conclusions.",
      jev_shadow_consent: true,
      status: "transcribing",
      source_duration_seconds: 1_200,
    };
    const episode = {
      id: episodeId,
      user_id: userId,
      source_type: "upload",
      source_url: null,
      source_storage_path: `${userId}/shorts/source.mp4`,
      status: "ready",
    };

    const queryFor = (data: unknown) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data, error: null })),
      };
      return query;
    };
    const projectQuery = queryFor(project);
    const episodeQuery = queryFor(episode);
    const from = vi.fn((table: string) => {
      if (table === "shorts_projects") return projectQuery;
      if (table === "episodes") return episodeQuery;
      throw new Error(`unexpected_table:${table}`);
    });
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "shorts_claim_analysis_job") {
        return {
          data: [
            {
              id: jobId,
              project_id: projectId,
              user_id: userId,
              episode_id: episodeId,
              status: "processing",
              attempt_count: 1,
              lease_token: leaseToken,
            },
          ],
          error: null,
        };
      }
      if (
        name === "shorts_mark_analysis_analyzing" ||
        name === "shorts_adjust_analysis_quota"
      ) {
        return { data: true, error: null };
      }
      if (name === "shorts_complete_analysis_job") {
        completionArguments.push(args ?? {});
        return { data: true, error: null };
      }
      throw new Error(`unexpected_rpc:${name}`);
    });
    const admin = { rpc, from } as unknown as SupabaseClient;
    const environment = {
      ...validEnvironment,
      CLIPS_VISUAL_ANALYSIS_ENABLED: "true",
      CLIPS_VISUAL_ANALYSIS_PROVIDER: "openai",
      CLIPS_JEV_HOOK_SCORE: "shadow",
      TYPESAFE_API_KEY: "test-typesafe-key",
    };
    const sourcePath = join(tmpdir(), `clipsflow-analysis-test-${jobId}.mp4`);
    const candidateIds: string[] = [];
    const analyzeCandidates = vi.fn(
      async (input: AnalyzeLongformCandidatesInput) => {
        candidateIds.push(...input.candidateWindows.map(({ id }) => id));
        expect(input.candidateWindows).toHaveLength(3);
        return {
          version: "longform-analysis-v1" as const,
          summary: "Two separate moments with clear visual context.",
          moments: [
            {
              candidate_id: input.candidateWindows[0]!.id,
              score: 90,
              proposed_title: "First moment",
              hook: "Here is the first point.",
              rationale: "The transcript presents a complete first point.",
              music_mood: "focused" as const,
              motion_direction: "Highlight the first key phrase.",
            },
            {
              candidate_id: input.candidateWindows[1]!.id,
              score: 80,
              proposed_title: "Second moment",
              hook: "Here is the second point.",
              rationale: "The transcript presents a distinct second point.",
              music_mood: "warm" as const,
              motion_direction: "Use a restrained push-in.",
            },
          ],
        };
      },
    );
    const rankWithJev = vi.fn(
      async (input: JevShadowInput): Promise<JevShadowResult> => {
        expect(input.candidates).toHaveLength(2);
        expect(input.candidates.map(({ id }) => id)).toEqual([
          "candidate-001",
          "candidate-002",
        ]);
        expect(
          input.candidates.map(({ baselineRank }) => baselineRank),
        ).toEqual([1, 2]);
        return {
          status: "shadow_complete",
          model: "jev-1.13.0",
          inputTokens: 240,
          outputTokens: 48,
          results: input.candidates.map((candidate, index) => ({
            candidateId: candidate.id,
            baselineRank: candidate.baselineRank ?? null,
            shadowRank: index + 1,
            compositeScore: index === 0 ? 99 : 20,
            confidence: 1,
            dimensions: {
              hook: { score: index === 0 ? 3 : 0, confidence: 1 },
              standalone: { score: index === 0 ? 3 : 0, confidence: 1 },
              caption_clarity: {
                score: index === 0 ? 3 : 0,
                confidence: 1,
              },
              instruction_fit: {
                score: index === 0 ? 3 : 0,
                confidence: 1,
              },
            },
          })),
        };
      },
    );

    const result = await processOneShortsAnalysisJob(admin, {
      environment,
      resolveSource: vi.fn(async () => ({
        url: "https://media.example/episode",
      })),
      downloadSource: vi.fn(async () => ({
        path: sourcePath,
        bytes: 100,
        contentType: "video/mp4",
      })),
      probeMedia: vi.fn(async () => ({
        durationSeconds: 1_200,
        hasVideo: true,
      })),
      extractAudioChunk: vi.fn(async (_source, startSeconds) =>
        join(tmpdir(), `clipsflow-analysis-test-${jobId}-${startSeconds}.wav`),
      ),
      transcribe: vi.fn(async (_url, audioPath) => ({
        words: audioPath.endsWith("-0.wav")
          ? [
              { text: "First useful point.", start: 30, end: 34 },
              { text: "Second useful point.", start: 305, end: 310 },
            ]
          : audioPath.endsWith("-570.wav")
            ? [{ text: "Third useful point.", start: 35, end: 40 }]
            : [],
        detectedLanguage: "en",
        model: "whisper-test",
      })),
      analyzeCandidates,
      rankWithJev,
      extractVisualFrames: vi.fn(
        async (
          _source: string,
          windows: AnalyzeLongformCandidatesInput["candidateWindows"],
        ) =>
          windows.map((window) => ({
            candidateId: window.id,
            frames: [
              {
                timestampSeconds: window.start_seconds,
                bytes: new Uint8Array([1, 2, 3]),
              },
            ],
          })),
      ),
      analyzeVisualFrames: vi.fn(
        async (
          frameSets: readonly ShortsVisualFrameSet[],
        ): Promise<ShortsVisualSummary[]> =>
          frameSets.map(({ candidateId }) => ({
            candidateId,
            summary: `Visual evidence for ${candidateId}.`,
            visualScore: candidateId === candidateIds[0] ? 20 : 100,
          })),
      ),
    });

    expect(result).toEqual({ kind: "completed", jobId });
    expect(rankWithJev).toHaveBeenCalledTimes(1);
    expect(candidateIds).toEqual([
      "candidate-001",
      "candidate-002",
      "candidate-003",
    ]);
    expect(completionArguments).toHaveLength(1);

    const completed = completionArguments[0]!;
    const persistedCandidates = completed.p_candidates as Array<{
      rank: number;
      score: number;
      title: string;
    }>;
    expect(persistedCandidates).toEqual([
      expect.objectContaining({
        rank: 1,
        score: 84,
        title: "Second moment",
      }),
      expect.objectContaining({
        rank: 2,
        score: 76,
        title: "First moment",
      }),
    ]);

    const payload = completed.p_analysis_payload as {
      jev_shadow: {
        results: Array<{ candidate_id: string; shadow_rank: number }>;
      };
      visual_ranking: {
        candidates: Array<{
          candidate_id: string;
          audio_score: number;
          visual_score: number;
          final_score: number;
        }>;
      };
    };
    expect(payload.visual_ranking.candidates).toEqual([
      {
        candidate_id: "candidate-001",
        audio_score: 90,
        visual_score: 20,
        final_score: 76,
      },
      {
        candidate_id: "candidate-002",
        audio_score: 80,
        visual_score: 100,
        final_score: 84,
      },
    ]);
    expect(payload.jev_shadow.results).toEqual([
      expect.objectContaining({
        candidate_id: "candidate-001",
        shadow_rank: 1,
      }),
      expect.objectContaining({
        candidate_id: "candidate-002",
        shadow_rank: 2,
      }),
    ]);
  });

  it("re-bases timestamp chunks and removes the repeated 30-second overlap", () => {
    const words = mergeLongformTranscriptionChunks([
      {
        startSeconds: 0,
        skipLeadingSeconds: 0,
        words: [
          { text: "The", start: 568, end: 568.2 },
          { text: "same", start: 569, end: 569.3 },
        ],
      },
      {
        startSeconds: 570,
        skipLeadingSeconds: 30,
        words: [
          { text: "same", start: 2, end: 2.3 },
          { text: "idea", start: 30, end: 30.4 },
          { text: "continues", start: 30.5, end: 31 },
        ],
      },
    ]);
    expect(words).toEqual([
      { text: "The", start: 568, end: 568.2 },
      { text: "same", start: 569, end: 569.3 },
      { text: "idea", start: 600, end: 600.4 },
      { text: "continues", start: 600.5, end: 601 },
    ]);
  });
});
