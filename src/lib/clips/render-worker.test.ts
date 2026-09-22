import { describe, expect, it, vi } from "vitest";

vi.mock("./run-job", () => ({
  getRenderArtifactPaths: vi.fn(() => ({
    mp4: "user/clip/attempts/lease.mp4",
    vtt: "user/clip/attempts/lease.vtt",
  })),
  runRenderJob: vi.fn(),
}));

import { runRenderJob } from "./run-job";
import { processOneRenderJob } from "./render-worker";

const LEASED_JOB = {
  id: "job-1",
  type: "render",
  user_id: "user-1",
  episode_id: "episode-1",
  clip_id: "clip-1",
  payload: { clip_id: "clip-1" },
  status: "processing",
  attempt_count: 1,
  claimed_at: "2026-09-22T00:00:00Z",
  lease_token: "lease-1",
  lease_expires_at: "2026-09-22T00:10:00Z",
  refund_applied_at: null,
  error_message: null,
  created_at: "2026-09-22T00:00:00Z",
  completed_at: null,
};

describe("processOneRenderJob", () => {
  it("exits cleanly when no render is queued", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const result = await processOneRenderJob({ rpc } as never);

    expect(result).toEqual({ kind: "empty" });
    expect(rpc).toHaveBeenCalledWith("clips_claim_render_job", {
      p_lease_seconds: 600,
    });
  });

  it("finalizes a successful render with the exact lease token", async () => {
    vi.mocked(runRenderJob).mockResolvedValueOnce({
      video_url: "https://signed.example/video",
      video_storage_path: "user/clip/attempts/lease.mp4",
      captions_vtt_url: "https://signed.example/captions",
      captions_vtt_storage_path: "user/clip/attempts/lease.vtt",
      thumbnail_url: null,
      thumbnail_storage_path: null,
      cost_usd: 0.01,
      score: 80,
      hook_text: "A hook",
      detected_language: "fr",
    });
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [LEASED_JOB], error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    const result = await processOneRenderJob({ rpc } as never);

    expect(result).toEqual({ kind: "completed", jobId: "job-1" });
    expect(runRenderJob).toHaveBeenCalledWith(expect.anything(), LEASED_JOB, {
      leaseToken: "lease-1",
    });
    expect(rpc).toHaveBeenLastCalledWith("clips_complete_render_job", {
      p_job_id: "job-1",
      p_lease_token: "lease-1",
      p_video_url: "https://signed.example/video",
      p_video_storage_path: "user/clip/attempts/lease.mp4",
      p_captions_vtt_url: "https://signed.example/captions",
      p_captions_vtt_storage_path: "user/clip/attempts/lease.vtt",
      p_cost_usd: 0.01,
      p_score: 80,
      p_hook_text: "A hook",
    });
  });
});
