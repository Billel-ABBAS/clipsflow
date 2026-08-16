import type { SupabaseClient } from "@supabase/supabase-js";

export interface SubmitClipJobInput {
  userId: string;
  episodeId: string;
  startSeconds: number;
  endSeconds: number;
  styleKey: string;
  aspectRatio: string;
  language: string;
  customizations: Record<string, unknown>;
  overlays: unknown[];
}

export interface SubmitClipJobResult {
  clipId: string;
  jobId: string;
  remaining: number;
}

export type SubmitClipJobErrorCode =
  | "episode_not_found"
  | "profile_not_found"
  | "quota_exceeded"
  | "submit_failed";

export class SubmitClipJobError extends Error {
  constructor(
    public readonly code: SubmitClipJobErrorCode,
    public readonly remaining?: number,
  ) {
    super(`submit_clip_job:${code}`);
    this.name = "SubmitClipJobError";
  }
}

interface SubmitClipJobRow {
  clip_id: unknown;
  job_id: unknown;
  remaining_seconds: unknown;
  error_code: unknown;
}

function firstRow(data: unknown): SubmitClipJobRow | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  const row = data[0];
  if (!row || typeof row !== "object") return null;
  return row as SubmitClipJobRow;
}

/**
 * Submit a render unit through the service-role-only transactional RPC.
 * Database details are deliberately not copied into the public error.
 */
export async function submitClipJob(
  supabase: SupabaseClient,
  input: SubmitClipJobInput,
): Promise<SubmitClipJobResult> {
  const { data, error } = await supabase.rpc("clips_submit_job", {
    p_user_id: input.userId,
    p_episode_id: input.episodeId,
    p_start_seconds: input.startSeconds,
    p_end_seconds: input.endSeconds,
    p_style_key: input.styleKey,
    p_aspect_ratio: input.aspectRatio,
    p_language: input.language,
    p_customizations: input.customizations,
    p_overlays: input.overlays,
  });

  if (error) throw new SubmitClipJobError("submit_failed");

  const row = firstRow(data);
  if (!row) throw new SubmitClipJobError("submit_failed");

  const remaining =
    typeof row.remaining_seconds === "number" ? row.remaining_seconds : 0;
  if (row.error_code === "quota_exceeded") {
    throw new SubmitClipJobError("quota_exceeded", remaining);
  }
  if (row.error_code === "profile_not_found") {
    throw new SubmitClipJobError("profile_not_found");
  }
  if (row.error_code === "episode_not_found") {
    throw new SubmitClipJobError("episode_not_found");
  }

  if (
    row.error_code !== null ||
    typeof row.clip_id !== "string" ||
    typeof row.job_id !== "string" ||
    typeof row.remaining_seconds !== "number"
  ) {
    throw new SubmitClipJobError("submit_failed");
  }

  return {
    clipId: row.clip_id,
    jobId: row.job_id,
    remaining,
  };
}
