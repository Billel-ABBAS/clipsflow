/**
 * Controlled negative Railway worker smoke test for the authorized staging
 * project. It submits an intentionally invalid, tiny MP4 payload and proves
 * that the worker fails it safely: one terminal failure, quota restored, no
 * persisted outputs, and complete test-user cleanup.
 *
 * Required environment variables:
 *   CLIPS_SMOKE_ENV_FILE    Absolute path to a staging-only env file.
 * Optional:
 *   CLIPS_SMOKE_EXPECTED_REF Expected Supabase project ref.
 *   CLIPS_SMOKE_TIMEOUT_MS  Queue wait timeout (default: 15 minutes).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { submitClipJob } from "../src/lib/clips/submit-job";

const POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const INVALID_MP4 = Buffer.from(
  "ClipsFlow staging failure smoke: this is deliberately not a media container.",
  "utf8",
);

type TerminalJob = {
  status: "completed" | "failed";
  attempt_count: number;
};

type FailedClip = {
  status: string;
  video_storage_path: string | null;
  captions_vtt_storage_path: string | null;
  error_message: string | null;
};

type StorageEntry = { id?: string | null; name: string };

function fail(message: string): never {
  throw new Error(`staging_render_failure_smoke:${message}`);
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertNoError(
  operation: string,
  result: { error: { message: string } | null },
): Promise<void> {
  if (result.error) fail(`${operation}_failed`);
}

async function waitForTerminalJob(
  supabase: SupabaseClient,
  jobId: string,
  timeoutMs: number,
): Promise<TerminalJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("jobs")
      .select("status, attempt_count")
      .eq("id", jobId)
      .single();
    await assertNoError("read_job", { error });
    if (data?.status === "completed" || data?.status === "failed") {
      return data as TerminalJob;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail("worker_timeout_leaving_test_data_intact");
}

async function listFiles(
  supabase: SupabaseClient,
  bucket: "clip-sources" | "clip-outputs",
  prefix: string,
  remainingDepth = 4,
): Promise<string[]> {
  if (remainingDepth <= 0) fail("storage_tree_too_deep");
  const result = await supabase.storage
    .from(bucket)
    .list(prefix, { limit: 100 });
  await assertNoError(`list_${bucket}`, result);
  const entries = (result.data ?? []) as StorageEntry[];
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${prefix}/${entry.name}`;
      return entry.id
        ? [path]
        : listFiles(supabase, bucket, path, remainingDepth - 1);
    }),
  );
  return nested.flat();
}

async function removeFiles(
  supabase: SupabaseClient,
  bucket: "clip-sources" | "clip-outputs",
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const result = await supabase.storage.from(bucket).remove(paths);
  await assertNoError(`remove_${bucket}`, result);
}

async function assertCountZero(
  supabase: SupabaseClient,
  table: "profiles" | "episodes" | "clips" | "jobs" | "ai_disclosure_events",
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
  const runTag = `railway-failure-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const email = `${runTag}@example.invalid`;
  let userId: string | null = null;
  let terminal = false;

  try {
    const created = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: "ClipsFlow staging failure smoke test" },
    });
    await assertNoError("create_test_user", created);
    if (!created.data.user) fail("missing_test_user");
    userId = created.data.user.id;

    const profile = await supabase
      .from("profiles")
      .update({
        plan: "free",
        locale: "en",
        full_name: "ClipsFlow staging failure smoke test",
      })
      .eq("id", userId);
    await assertNoError("prepare_test_profile", profile);

    const sourcePath = `${userId}/${runTag}.mp4`;
    const uploaded = await supabase.storage
      .from("clip-sources")
      .upload(sourcePath, INVALID_MP4, {
        contentType: "video/mp4",
        upsert: false,
      });
    await assertNoError("upload_invalid_source", uploaded);

    const episode = await supabase
      .from("episodes")
      .insert({
        user_id: userId,
        title: "ClipsFlow Railway staging failure smoke test",
        source_type: "upload",
        source_storage_path: sourcePath,
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
    console.info(
      JSON.stringify({
        event: "staging_failure_smoke_queued",
        run_tag: runTag,
      }),
    );

    const timeoutMs = Number(
      process.env.CLIPS_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    );
    const job = await waitForTerminalJob(supabase, submitted.jobId, timeoutMs);
    terminal = true;
    if (job.status !== "failed" || job.attempt_count !== 1) {
      fail("invalid_source_not_failed_once");
    }

    const clip = await supabase
      .from("clips")
      .select(
        "status, video_storage_path, captions_vtt_storage_path, error_message",
      )
      .eq("id", submitted.clipId)
      .single();
    await assertNoError("read_failed_clip", clip);
    const failedClip = clip.data as FailedClip | null;
    if (
      !failedClip ||
      failedClip.status !== "failed" ||
      failedClip.video_storage_path !== null ||
      failedClip.captions_vtt_storage_path !== null ||
      !failedClip.error_message
    ) {
      fail("failed_clip_state_invalid");
    }

    const profileAfter = await supabase
      .from("profiles")
      .select("clip_seconds_used_this_month")
      .eq("id", userId)
      .single();
    await assertNoError("read_refunded_profile", profileAfter);
    if (profileAfter.data?.clip_seconds_used_this_month !== 0) {
      fail("quota_not_refunded");
    }

    const outputFiles = await listFiles(supabase, "clip-outputs", userId);
    if (outputFiles.length !== 0) fail("orphaned_output_artifacts");
    console.info(
      JSON.stringify({
        event: "staging_failure_smoke_verified",
        run_tag: runTag,
      }),
    );
  } finally {
    if (userId && terminal) {
      const [sourceFiles, outputFiles] = await Promise.all([
        listFiles(supabase, "clip-sources", userId),
        listFiles(supabase, "clip-outputs", userId),
      ]);
      await Promise.all([
        removeFiles(supabase, "clip-sources", sourceFiles),
        removeFiles(supabase, "clip-outputs", outputFiles),
      ]);
      const deleted = await supabase.auth.admin.deleteUser(userId);
      await assertNoError("delete_test_user", deleted);
      await Promise.all([
        assertCountZero(supabase, "profiles", userId),
        assertCountZero(supabase, "episodes", userId),
        assertCountZero(supabase, "clips", userId),
        assertCountZero(supabase, "jobs", userId),
        assertCountZero(supabase, "ai_disclosure_events", userId),
      ]);
      console.info(
        JSON.stringify({
          event: "staging_failure_smoke_cleanup_verified",
          run_tag: runTag,
        }),
      );
    } else if (userId) {
      console.error(
        JSON.stringify({
          event: "staging_failure_smoke_cleanup_deferred",
          run_tag: runTag,
        }),
      );
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      event: "staging_failure_smoke_failed",
      error: message.slice(0, 240),
    }),
  );
  process.exitCode = 1;
});
