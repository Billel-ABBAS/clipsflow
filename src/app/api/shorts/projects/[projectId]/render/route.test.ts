import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  isClipsEnabled: vi.fn(),
  isClipsWorkerEnabled: vi.fn(),
  rateLimit: vi.fn(),
  projectMaybeSingle: vi.fn(),
  candidateRows: vi.fn(),
  episodeMaybeSingle: vi.fn(),
  profileMaybeSingle: vi.fn(),
  submitClipJob: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "fr" }) }),
}));

vi.mock("@/lib/clips/feature-flag", () => ({
  isClipsEnabled: mocks.isClipsEnabled,
  isClipsWorkerEnabled: mocks.isClipsWorkerEnabled,
}));

vi.mock("@/lib/rate-limit-distributed", () => ({
  checkDistributedRateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => {
  const query = (result: () => Promise<unknown>) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => result(),
      maybeSingle: () => result(),
    };
    return builder;
  };
  return {
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === "shorts_projects") return query(mocks.projectMaybeSingle);
        if (table === "shorts_candidates") return query(mocks.candidateRows);
        if (table === "episodes") return query(mocks.episodeMaybeSingle);
        if (table === "profiles") return query(mocks.profileMaybeSingle);
        throw new Error(`Unexpected table ${table}`);
      },
    }),
  };
});

vi.mock("@/lib/clips/creative-director", () => ({
  CreativeDirectorError: class CreativeDirectorError extends Error {},
  resolveCreativeDirectorConfig: vi.fn(),
}));

vi.mock("@/lib/clips/creative-director-model", () => ({
  CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED: true,
}));

vi.mock("@/lib/clips/elevenlabs-render", () => ({
  hasCachedShortsAudioAsset: vi.fn(),
  resolveShortsMotionEffect: vi.fn(),
  resolveShortsMusicPrompt: vi.fn(),
}));

vi.mock("@/lib/clips/quota", () => ({
  resolvePlan: () => "pro",
  stripCustomizationsByPlan: (_plan: unknown, customizations: unknown) =>
    customizations,
}));

vi.mock("@/lib/clips/submit-job", () => ({
  SubmitClipJobError: class SubmitClipJobError extends Error {},
  submitClipJob: mocks.submitClipJob,
}));

vi.mock("@/lib/clips/transcript-window", () => ({
  transcriptWindow: () => ({ words: [] }),
}));

vi.mock("@/lib/shorts/render-submission", () => ({
  canRenderShortsWithAudioProfile: (profile: {
    elevenlabs: { enabled: boolean };
  }) => !profile.elevenlabs.enabled,
  shortsMotionAnimationSpeed: (template: string, reduced: boolean) =>
    `${template}:${String(reduced)}`,
  shortsRenderRequestId: (projectId: string, candidateId: string) =>
    `${projectId}:${candidateId}`,
  shortsTitleCardOverlay: () => null,
}));

import { POST } from "./route";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const episodeId = "123e4567-e89b-42d3-a456-426614174001";
const userId = "123e4567-e89b-42d3-a456-426614174002";
const firstCandidateId = "123e4567-e89b-42d3-a456-426614174003";
const secondCandidateId = "123e4567-e89b-42d3-a456-426614174004";

const musicOffProfile = {
  aspect_ratio: "9:16",
  subtitle_style: "viral",
  subtitles: { synchronized: true, auto_emphasis: true },
  motion: {
    template: "editorial-focus",
    reduced_motion: false,
    renderer: "deterministic",
  },
  elevenlabs: {
    enabled: false,
    explicit_consent: false,
    commercial_license_confirmed: false,
    use_cases: [],
    synthetic_voice: false,
  },
  creative_direction: { enabled: false, explicit_consent: false },
} as const;

const reducedMotionProfile = {
  ...musicOffProfile,
  aspect_ratio: "1:1",
  subtitle_style: "premium",
  subtitles: { synchronized: true, auto_emphasis: false },
  motion: {
    template: "minimal-static",
    reduced_motion: true,
    renderer: "deterministic",
  },
} as const;

function candidate(
  id: string,
  productionProfile: typeof musicOffProfile | typeof reducedMotionProfile,
) {
  return {
    id,
    episode_id: episodeId,
    start_seconds: id === firstCandidateId ? 10 : 80,
    end_seconds: id === firstCandidateId ? 60 : 130,
    title: id === firstCandidateId ? "First excerpt" : "Second excerpt",
    hook: "A bounded hook for a tested Short.",
    music_mood: "focused",
    motion_direction: "Keep emphasis precise and sparse.",
    visual_summary: null,
    selected: true,
    production_profile: productionProfile,
  };
}

function request() {
  return new Request(
    `http://localhost/api/shorts/projects/${projectId}/render`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidate_ids: [firstCandidateId, secondCandidateId],
      }),
    },
  );
}

function context() {
  return { params: Promise.resolve({ projectId }) };
}

describe("POST /api/shorts/projects/[projectId]/render", () => {
  beforeEach(() => {
    vi.stubEnv("CLIPS_AI_BUDGET_AUTHORIZED", "false");
    mocks.getUser
      .mockReset()
      .mockResolvedValue({ data: { user: { id: userId } } });
    mocks.isClipsEnabled.mockReset().mockReturnValue(true);
    mocks.isClipsWorkerEnabled.mockReset().mockReturnValue(true);
    mocks.rateLimit.mockReset().mockResolvedValue({ allowed: true });
    mocks.projectMaybeSingle.mockReset().mockResolvedValue({
      data: {
        id: projectId,
        episode_id: episodeId,
        status: "ready",
        user_instructions: "",
      },
      error: null,
    });
    mocks.candidateRows.mockReset().mockResolvedValue({
      data: [
        candidate(firstCandidateId, musicOffProfile),
        candidate(secondCandidateId, reducedMotionProfile),
      ],
      error: null,
    });
    mocks.episodeMaybeSingle.mockReset().mockResolvedValue({
      data: { id: episodeId, transcript_segments: [] },
      error: null,
    });
    mocks.profileMaybeSingle.mockReset().mockResolvedValue({
      data: { plan: "pro" },
      error: null,
    });
    mocks.submitClipJob
      .mockReset()
      .mockResolvedValueOnce({ clipId: "clip-first", jobId: "job-first" })
      .mockResolvedValueOnce({ clipId: "clip-second", jobId: "job-second" });
  });

  it("queues two selected Shorts with their own aspect, captions, and motion profiles", async () => {
    const response = await POST(request(), context());
    const payload = (await response.json()) as {
      data: { queued_count: number; results: unknown[] };
    };

    expect(response.status).toBe(202);
    expect(payload.data.queued_count).toBe(2);
    expect(mocks.submitClipJob).toHaveBeenCalledTimes(2);
    expect(mocks.submitClipJob).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        aspectRatio: "9:16",
        styleKey: "viral",
        customizations: expect.objectContaining({
          animation_speed: "editorial-focus:false",
          shorts: expect.objectContaining({
            candidate_id: firstCandidateId,
            motion_template: "editorial-focus",
            reduced_motion: false,
          }),
        }),
      }),
    );
    expect(mocks.submitClipJob).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        aspectRatio: "1:1",
        styleKey: "premium",
        customizations: expect.objectContaining({
          animation_speed: "minimal-static:true",
          shorts: expect.objectContaining({
            candidate_id: secondCandidateId,
            motion_template: "minimal-static",
            reduced_motion: true,
          }),
        }),
      }),
    );
  });
});
