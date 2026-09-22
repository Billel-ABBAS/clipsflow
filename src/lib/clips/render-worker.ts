// ============================================================================
// ClipsFlow — Railway render worker lifecycle
// ============================================================================
// Owns exactly one render claim per invocation.  Database RPCs fence every
// state transition with a renewable lease token; this module must only ever
// receive a service-role Supabase client.

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRenderArtifactPaths, runRenderJob } from "./run-job";
import type { QueueJob } from "./types";

export const RENDER_LEASE_SECONDS = 600;
export const RENDER_LEASE_HEARTBEAT_MS = 60_000;

export type RenderWorkerResult =
  | { kind: "empty" }
  | { kind: "completed"; jobId: string }
  | { kind: "failed"; jobId: string }
  | { kind: "stale"; jobId: string };

type LeasedRenderJob = QueueJob & {
  type: "render";
  lease_token: string;
  lease_expires_at: string;
};

function errorPrefix(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([^:\s]+):\s/)?.[1] ?? "unknown";
}

function getClipId(job: QueueJob): string | null {
  if (job.clip_id) return job.clip_id;
  const payloadClipId = job.payload?.clip_id;
  return typeof payloadClipId === "string" ? payloadClipId : null;
}

function isLeasedRenderJob(value: unknown): value is LeasedRenderJob {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.type === "render" &&
    typeof row.id === "string" &&
    typeof row.user_id === "string" &&
    typeof row.lease_token === "string" &&
    typeof row.lease_expires_at === "string"
  );
}

function log(
  level: "info" | "warn" | "error",
  message: string,
  context: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    source: "railway-clips-worker",
    message,
    ...context,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

async function removeAttemptArtifacts(
  supabase: SupabaseClient,
  job: LeasedRenderJob,
): Promise<void> {
  const clipId = getClipId(job);
  if (!clipId) return;
  const paths = getRenderArtifactPaths(job.user_id, clipId, job.lease_token);
  const { error } = await supabase.storage
    .from("clip-outputs")
    .remove([paths.mp4, paths.vtt]);
  if (error) {
    log("warn", "stale artifact cleanup failed", {
      job_id: job.id,
      error: error.message.slice(0, 200),
    });
  }
}

/**
 * Claims and processes at most one queued render.  A handled render failure
 * returns `failed` and lets Railway exit cleanly; infrastructure/RPC failures
 * are re-thrown so they remain visible in the cron execution logs.
 */
export async function processOneRenderJob(
  supabase: SupabaseClient,
): Promise<RenderWorkerResult> {
  const { data, error } = await supabase.rpc("clips_claim_render_job", {
    p_lease_seconds: RENDER_LEASE_SECONDS,
  });
  if (error) {
    throw new Error(`claim_render_job_failed: ${error.message.slice(0, 300)}`);
  }

  const candidate = Array.isArray(data) ? data[0] : null;
  if (!candidate) return { kind: "empty" };
  if (!isLeasedRenderJob(candidate)) {
    throw new Error("claim_render_job_failed: malformed leased job response");
  }
  const job = candidate;
  let leaseLost = false;
  let renewInFlight = false;

  const heartbeat = setInterval(() => {
    if (renewInFlight || leaseLost) return;
    renewInFlight = true;
    void Promise.resolve(
      supabase.rpc("clips_renew_render_lease", {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_lease_seconds: RENDER_LEASE_SECONDS,
      }),
    )
      .then(({ data: renewed, error: renewError }) => {
        if (renewError || renewed !== true) {
          leaseLost = true;
          log("warn", "render lease lost", {
            job_id: job.id,
            reason: renewError?.message.slice(0, 200) ?? "renewal_rejected",
          });
        }
      })
      .catch(() => {
        leaseLost = true;
      })
      .finally(() => {
        renewInFlight = false;
      });
  }, RENDER_LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const result = await runRenderJob(supabase, job, {
      leaseToken: job.lease_token,
    });
    if (leaseLost) {
      await removeAttemptArtifacts(supabase, job);
      return { kind: "stale", jobId: job.id };
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "clips_complete_render_job",
      {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_video_url: result.video_url,
        p_video_storage_path: result.video_storage_path,
        p_captions_vtt_url: result.captions_vtt_url,
        p_captions_vtt_storage_path: result.captions_vtt_storage_path,
        p_cost_usd: result.cost_usd,
        p_score: result.score,
        p_hook_text: result.hook_text,
      },
    );
    if (completeError) {
      throw new Error(
        `complete_render_job_failed: ${completeError.message.slice(0, 300)}`,
      );
    }
    if (completed !== true) {
      await removeAttemptArtifacts(supabase, job);
      return { kind: "stale", jobId: job.id };
    }

    log("info", "render completed", { job_id: job.id });
    return { kind: "completed", jobId: job.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (leaseLost) {
      await removeAttemptArtifacts(supabase, job);
      return { kind: "stale", jobId: job.id };
    }

    try {
      const { data: failed, error: failError } = await supabase.rpc(
        "clips_fail_render_job",
        {
          p_job_id: job.id,
          p_lease_token: job.lease_token,
          p_error_message: message.slice(0, 400),
        },
      );
      if (failError) {
        throw new Error(
          `fail_render_job_failed: ${failError.message.slice(0, 300)}`,
        );
      }
      if (failed !== true) {
        await removeAttemptArtifacts(supabase, job);
        return { kind: "stale", jobId: job.id };
      }
    } catch (finalizationError) {
      Sentry.captureException(finalizationError, {
        tags: {
          feature: "clips",
          worker: "railway",
          stage: "finalize_failure",
        },
        extra: { job_id: job.id },
      });
      throw finalizationError;
    }

    await removeAttemptArtifacts(supabase, job);
    Sentry.captureException(error, {
      tags: {
        feature: "clips",
        worker: "railway",
        error_prefix: errorPrefix(error),
      },
      extra: { job_id: job.id, attempt_count: job.attempt_count },
    });
    log("error", "render failed", {
      job_id: job.id,
      error_prefix: errorPrefix(error),
      error: message.slice(0, 400),
    });
    return { kind: "failed", jobId: job.id };
  } finally {
    clearInterval(heartbeat);
  }
}
