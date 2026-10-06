/**
 * Controlled lease-fencing smoke test for the authorized ClipsFlow staging
 * project. It proves that a late worker cannot finish a reclaimed job and that
 * the second expired lease produces one terminal refund. It never starts a
 * renderer or uploads a media file.
 *
 * Required environment variables:
 *   CLIPS_SMOKE_ENV_FILE     Absolute path to a staging-only env file.
 * Optional:
 *   CLIPS_SMOKE_EXPECTED_REF Expected Supabase project ref.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { submitClipJob } from "../src/lib/clips/submit-job";

const LEASE_SECONDS = 120;

type ClaimedJob = {
  id: string;
  lease_token: string;
  attempt_count: number;
};

function fail(message: string): never {
  throw new Error(`staging_render_lease_fencing_smoke:${message}`);
}

function envValue(contents: string, name: string): string | null {
  const line = contents
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) return null;
  const raw = line.slice(name.length + 1).trim();
  const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2");
  return unquoted.length > 0 ? unquoted : null;
}

async function loadStagingClient(): Promise<SupabaseClient> {
  const envFile = process.env.CLIPS_SMOKE_ENV_FILE;
  if (!envFile) fail("missing_env_file");
  const contents = await readFile(envFile, "utf8");
  const url = envValue(contents, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = envValue(contents, "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) fail("missing_staging_supabase_settings");

  const expectedRef = process.env.CLIPS_SMOKE_EXPECTED_REF;
  if (expectedRef && !url.includes(`https://${expectedRef}.supabase.co`)) {
    fail("unexpected_supabase_project");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function assertNoError(
  operation: string,
  result: { error: { message: string } | null },
): Promise<void> {
  if (result.error) fail(`${operation}_failed`);
}

function asClaim(data: unknown, expectedJobId: string): ClaimedJob {
  if (!Array.isArray(data) || data.length !== 1) fail("expected_one_claim");
  const row = data[0];
  if (
    !row ||
    typeof row !== "object" ||
    (row as { id?: unknown }).id !== expectedJobId ||
    typeof (row as { lease_token?: unknown }).lease_token !== "string" ||
    typeof (row as { attempt_count?: unknown }).attempt_count !== "number"
  ) {
    fail("invalid_claim");
  }
  return row as ClaimedJob;
}

async function expireLease(
  supabase: SupabaseClient,
  jobId: string,
  token: string,
): Promise<void> {
  const expired = await supabase
    .from("jobs")
    .update({ lease_expires_at: new Date(Date.now() - 1_000).toISOString() })
    .eq("id", jobId)
    .eq("lease_token", token)
    .select("id")
    .maybeSingle();
  await assertNoError("expire_lease", expired);
  if (expired.data?.id !== jobId) fail("lease_not_expired");
}

async function assertNoActiveRenderJobs(
  supabase: SupabaseClient,
): Promise<void> {
  const active = await supabase
    .from("jobs")
    .select("id")
    .eq("type", "render")
    .in("status", ["pending", "processing"])
    .limit(1);
  await assertNoError("read_active_render_jobs", active);
  if ((active.data ?? []).length > 0) fail("staging_queue_not_idle");
}

async function assertCleanup(
  supabase: SupabaseClient,
  table: "profiles" | "episodes" | "clips" | "jobs",
  userId: string,
): Promise<void> {
  const result =
    table === "profiles"
      ? await supabase
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("id", userId)
      : await supabase
          .from(table)
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId);
  await assertNoError(`verify_${table}_cleanup`, result);
  if (result.count !== 0) fail(`residual_${table}`);
}

async function main(): Promise<void> {
  const supabase = await loadStagingClient();
  await assertNoActiveRenderJobs(supabase);

  const runTag = `railway-lease-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const email = `${runTag}@example.invalid`;
  let userId: string | null = null;
  let terminal = false;

  try {
    const created = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        full_name: "ClipsFlow staging lease fencing smoke test",
      },
    });
    await assertNoError("create_test_user", created);
    if (!created.data.user) fail("missing_test_user");
    userId = created.data.user.id;

    const profile = await supabase
      .from("profiles")
      .update({
        plan: "free",
        locale: "en",
        full_name: "ClipsFlow staging lease fencing smoke test",
      })
      .eq("id", userId);
    await assertNoError("prepare_test_profile", profile);

    const episode = await supabase
      .from("episodes")
      .insert({
        user_id: userId,
        title: "ClipsFlow staging lease fencing smoke test",
        source_type: "upload",
        source_storage_path: `${userId}/${runTag}.mp4`,
        duration_seconds: 12,
        status: "ready",
      })
      .select("id")
      .single();
    await assertNoError("create_episode", episode);
    if (!episode.data?.id) fail("missing_episode");

    const submitted = await submitClipJob(supabase, {
      userId,
      episodeId: episode.data.id,
      requestId: randomUUID(),
      startSeconds: 0,
      endSeconds: 12,
      styleKey: "viral",
      aspectRatio: "9:16",
      language: "en",
      customizations: {},
      overlays: [],
    });

    const firstClaim = await supabase.rpc("clips_claim_render_job", {
      p_lease_seconds: LEASE_SECONDS,
    });
    await assertNoError("claim_first_lease", firstClaim);
    const first = asClaim(firstClaim.data, submitted.jobId);
    if (first.attempt_count !== 1) fail("invalid_first_attempt");

    await expireLease(supabase, submitted.jobId, first.lease_token);

    const secondClaim = await supabase.rpc("clips_claim_render_job", {
      p_lease_seconds: LEASE_SECONDS,
    });
    await assertNoError("claim_recovered_lease", secondClaim);
    const second = asClaim(secondClaim.data, submitted.jobId);
    if (
      second.attempt_count !== 2 ||
      second.lease_token === first.lease_token
    ) {
      fail("invalid_recovered_lease");
    }

    const staleCompletion = await supabase.rpc("clips_complete_render_job", {
      p_job_id: submitted.jobId,
      p_lease_token: first.lease_token,
      p_video_url: "https://example.invalid/stale.mp4",
      p_video_storage_path: "stale.mp4",
      p_captions_vtt_url: "https://example.invalid/stale.vtt",
      p_captions_vtt_storage_path: "stale.vtt",
      p_cost_usd: 0,
      p_score: 0,
      p_hook_text: "stale",
    });
    await assertNoError("attempt_stale_completion", staleCompletion);
    if (staleCompletion.data !== false) fail("stale_completion_accepted");

    const staleFailure = await supabase.rpc("clips_fail_render_job", {
      p_job_id: submitted.jobId,
      p_lease_token: first.lease_token,
      p_error_message: "stale worker must not refund",
    });
    await assertNoError("attempt_stale_failure", staleFailure);
    if (staleFailure.data !== false) fail("stale_failure_accepted");

    await expireLease(supabase, submitted.jobId, second.lease_token);

    const terminalRecovery = await supabase.rpc("clips_claim_render_job", {
      p_lease_seconds: LEASE_SECONDS,
    });
    await assertNoError("recover_second_expired_lease", terminalRecovery);
    if (
      Array.isArray(terminalRecovery.data) &&
      terminalRecovery.data.length > 0
    ) {
      fail("unexpected_claim_after_terminal_recovery");
    }

    const [job, clip, profileAfter] = await Promise.all([
      supabase
        .from("jobs")
        .select("status, attempt_count, refund_applied_at")
        .eq("id", submitted.jobId)
        .single(),
      supabase
        .from("clips")
        .select("status, error_message")
        .eq("id", submitted.clipId)
        .single(),
      supabase
        .from("profiles")
        .select("clip_seconds_used_this_month")
        .eq("id", userId)
        .single(),
    ]);
    await Promise.all([
      assertNoError("read_terminal_job", job),
      assertNoError("read_terminal_clip", clip),
      assertNoError("read_refunded_profile", profileAfter),
    ]);

    if (
      job.data?.status !== "failed" ||
      job.data.attempt_count !== 2 ||
      !job.data.refund_applied_at ||
      clip.data?.status !== "failed" ||
      clip.data.error_message !== "worker_interrupted" ||
      profileAfter.data?.clip_seconds_used_this_month !== 0
    ) {
      fail("terminal_fencing_or_refund_invalid");
    }
    terminal = true;
    console.info(
      JSON.stringify({
        event: "staging_lease_fencing_verified",
        run_tag: runTag,
        attempts: job.data.attempt_count,
      }),
    );
  } finally {
    // The staging Railway worker is paused for this smoke test, so no scheduler
    // can own this uniquely tagged user/job. Always remove the synthetic user,
    // even if an assertion failed midway; user-owned rows cascade and the
    // explicit count checks below prove that the temporary data is gone.
    if (userId) {
      const deleted = await supabase.auth.admin.deleteUser(userId);
      await assertNoError("delete_test_user", deleted);
      await Promise.all([
        assertCleanup(supabase, "profiles", userId),
        assertCleanup(supabase, "episodes", userId),
        assertCleanup(supabase, "clips", userId),
        assertCleanup(supabase, "jobs", userId),
      ]);
      console.info(
        JSON.stringify({
          event: "staging_lease_fencing_cleanup_verified",
          run_tag: runTag,
          completed: terminal,
        }),
      );
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      event: "staging_lease_fencing_failed",
      error: message.slice(0, 240),
    }),
  );
  process.exitCode = 1;
});
