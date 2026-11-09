import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  candidateId: "22222222-2222-4222-8222-222222222222",
  episodeId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
  rows: new Map<string, unknown>(),
  submit: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "fr" }) }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: fixture.userId } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: fixture.rows.get(table), error: null }),
      in: async () => ({ data: fixture.rows.get(table), error: null }),
    };
    return query;
  } }),
}));
vi.mock("@/lib/clips/feature-flag", () => ({ isClipsEnabled: () => true, isClipsWorkerEnabled: () => true }));
vi.mock("@/lib/rate-limit-distributed", () => ({ checkDistributedRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/clips/transcript-window", () => ({ transcriptWindow: () => [] }));
vi.mock("@/lib/clips/submit-job", () => ({
  submitClipJob: fixture.submit,
  SubmitClipJobError: class extends Error {},
}));

import { POST } from "./route";

const voiceover = {
  enabled: true, explicit_consent: true, voice_rights_confirmed: true,
  commercial_model_rights_confirmed: true,
};
const profile = {
  aspect_ratio: "9:16", subtitle_style: "viral",
  subtitles: { synchronized: true, auto_emphasis: true },
  motion: { template: "editorial-focus", reduced_motion: false, renderer: "deterministic" },
  elevenlabs: {
    enabled: false, explicit_consent: false, commercial_license_confirmed: false,
    use_cases: [], synthetic_voice: false,
  },
  creative_direction: { enabled: false, explicit_consent: false },
  voiceover,
};

beforeEach(() => {
  fixture.submit.mockReset();
  fixture.submit.mockResolvedValue({ clipId: "clip", jobId: "job" });
  fixture.rows.clear();
  fixture.rows.set("shorts_projects", {
    id: fixture.projectId, episode_id: fixture.episodeId, status: "ready", user_instructions: "",
  });
  fixture.rows.set("shorts_candidates", [{
    id: fixture.candidateId, episode_id: fixture.episodeId,
    start_seconds: 10, end_seconds: 30, title: "Un exemple", hook: "Une accroche autorisée.",
    music_mood: "focused", motion_direction: "editorial-focus", visual_summary: null,
    selected: true, production_profile: profile,
  }]);
  fixture.rows.set("episodes", { id: fixture.episodeId, transcript_segments: [] });
  fixture.rows.set("profiles", { plan: "pro" });
  vi.stubEnv("CLIPS_AI_BUDGET_AUTHORIZED", "false");
  vi.stubEnv("CLIPS_VOICESTUDIO_ENABLED", "true");
  vi.stubEnv("CLIPS_VOICESTUDIO_BASE_URL", "http://voicestudio:3900");
  vi.stubEnv("CLIPS_VOICESTUDIO_API_KEY", "synthetic-test-key");
  vi.stubEnv("CLIPS_VOICESTUDIO_TTS_MODEL", "approved-tts");
  vi.stubEnv("CLIPS_VOICESTUDIO_TTS_VOICE", "approved-voice");
  vi.stubEnv("CLIPS_VOICESTUDIO_MODEL_COMMERCIAL_OK", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("Shorts narration submission", () => {
  it("preserves the validated VoiceStudio authorisation in the worker job", async () => {
    const response = await POST(new Request("http://localhost/api/shorts/projects/test/render", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate_ids: [fixture.candidateId] }),
    }), { params: Promise.resolve({ projectId: fixture.projectId }) });
    expect(response.status).toBe(202);
    expect(fixture.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      customizations: expect.objectContaining({ shorts: expect.objectContaining({ voiceover }) }),
    }));
  });
});
