import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SubmitClipJobError,
  submitClipJob,
  type SubmitClipJobInput,
} from "./submit-job";

const validInput: SubmitClipJobInput = {
  userId: "00000000-0000-4000-8000-000000000001",
  episodeId: "00000000-0000-4000-8000-000000000002",
  startSeconds: 10,
  endSeconds: 40,
  styleKey: "viral",
  aspectRatio: "9:16",
  language: "fr",
  customizations: { text_color: "#FFFFFF" },
  overlays: [],
};

function rpcClient(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient;
}

describe("submitClipJob", () => {
  it("normalise la ligne RPC et transmet les paramètres attendus", async () => {
    const client = rpcClient({
      data: [
        {
          clip_id: "clip-1",
          job_id: "job-1",
          remaining_seconds: 30,
          error_code: null,
        },
      ],
      error: null,
    });

    await expect(submitClipJob(client, validInput)).resolves.toEqual({
      clipId: "clip-1",
      jobId: "job-1",
      remaining: 30,
    });
    expect(client.rpc).toHaveBeenCalledWith("clips_submit_job", {
      p_user_id: validInput.userId,
      p_episode_id: validInput.episodeId,
      p_start_seconds: 10,
      p_end_seconds: 40,
      p_style_key: "viral",
      p_aspect_ratio: "9:16",
      p_language: "fr",
      p_customizations: { text_color: "#FFFFFF" },
      p_overlays: [],
    });
  });

  it("expose quota_exceeded et le reliquat sans créer de résultat partiel", async () => {
    const client = rpcClient({
      data: [
        {
          clip_id: null,
          job_id: null,
          remaining_seconds: 12,
          error_code: "quota_exceeded",
        },
      ],
      error: null,
    });

    await expect(submitClipJob(client, validInput)).rejects.toMatchObject({
      code: "quota_exceeded",
      remaining: 12,
    });
  });

  it("convertit une erreur PostgREST en erreur contrôlée sans fuite de détail", async () => {
    const client = rpcClient({
      data: null,
      error: { message: "sensitive database detail", code: "XX000" },
    });

    const thrown = await submitClipJob(client, validInput).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(SubmitClipJobError);
    expect(thrown).toMatchObject({ code: "submit_failed" });
    expect((thrown as Error).message).not.toContain(
      "sensitive database detail",
    );
  });

  it("refuse une réponse RPC vide ou malformée", async () => {
    const client = rpcClient({ data: [], error: null });

    await expect(submitClipJob(client, validInput)).rejects.toMatchObject({
      code: "submit_failed",
    });
  });
});
