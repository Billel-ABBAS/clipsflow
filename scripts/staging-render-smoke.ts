/**
 * Controlled ClipsFlow staging render smoke test.
 *
 * It deliberately reads only the two Supabase server settings it needs from
 * CLIPS_SMOKE_ENV_FILE, creates a throwaway confirmed user, and removes the
 * generated storage objects plus the auth user after a terminal job state.
 * No credential, signed URL, transcript, or source media is ever logged.
 *
 * Required environment variables:
 *   CLIPS_SMOKE_ENV_FILE   Absolute path to an env file for staging.
 *   CLIPS_SMOKE_SOURCE     Absolute path to a short spoken MP4 fixture.
 *
 * Optional:
 *   CLIPS_SMOKE_EXPECTED_REF  Expected Supabase project ref.
 *   CLIPS_SMOKE_TIMEOUT_MS    Queue wait timeout (default: 15 minutes).
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { submitClipJob } from "../src/lib/clips/submit-job";

const POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

type TerminalJob = {
  status: "completed" | "failed";
  attempt_count: number;
};

type RenderedClip = {
  status: string;
  video_storage_path: string | null;
  captions_vtt_storage_path: string | null;
  error_message: string | null;
};

type DisclosureEvent = {
  clip_id: string;
  surface: string;
  disclosure_version: string;
  metadata: Record<string, unknown>;
};

function fail(message: string): never {
  throw new Error(`staging_render_smoke:${message}`);
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

async function removeIfPresent(
  supabase: SupabaseClient,
  bucket: "clip-sources" | "clip-outputs",
  paths: Array<string | null>,
): Promise<void> {
  const uniquePaths = [
    ...new Set(paths.filter((path): path is string => !!path)),
  ];
  if (uniquePaths.length === 0) return;
  const result = await supabase.storage.from(bucket).remove(uniquePaths);
  await assertNoError(`remove_${bucket}`, result);
}

async function assertCountZero(
  supabase: SupabaseClient,
  table: "profiles" | "episodes" | "clips" | "jobs" | "ai_disclosure_events",
  userId: string,
): Promise<void> {
  if (table === "profiles") {
    const profileResult = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("id", userId);
    await assertNoError(`verify_${table}_cleanup`, profileResult);
    if (profileResult.count !== 0) fail(`residual_${table}`);
    return;
  }
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  await assertNoError(`verify_${table}_cleanup`, { error });
  if (count !== 0) fail(`residual_${table}`);
}

async function assertDisclosureEvent(
  supabase: SupabaseClient,
  clipId: string,
): Promise<void> {
  const result = await supabase
    .from("ai_disclosure_events")
    .select("clip_id, surface, disclosure_version, metadata")
    .eq("clip_id", clipId)
    .eq("surface", "clip_subtitle")
    .eq("disclosure_version", "ai-act-art-50-v1")
    .single();
  await assertNoError("read_disclosure_event", result);
  const event = result.data as DisclosureEvent | null;
  if (
    !event ||
    event.clip_id !== clipId ||
    event.metadata?.content_kind !== "generated_subtitle_overlay"
  ) {
    fail("missing_or_invalid_disclosure_event");
  }
}

async function main(): Promise<void> {
  const sourceFile = process.env.CLIPS_SMOKE_SOURCE;
  if (!sourceFile) fail("missing_source_fixture");
  const source = await readFile(sourceFile);
  const sourceStats = await stat(sourceFile);
  if (sourceStats.size === 0 || sourceStats.size > 50 * 1024 * 1024) {
    fail("invalid_source_fixture_size");
  }

  const supabase = await loadStagingClient();
  const runTag = `railway-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const email = `${runTag}@example.invalid`;
  let userId: string | null = null;
  let sourcePath: string | null = null;
  let outputPaths: Array<string | null> = [];
  let submittedJobId: string | null = null;
  let terminal = false;

  try {
    const created = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: "ClipsFlow staging smoke test" },
    });
    await assertNoError("create_test_user", created);
    if (!created.data.user) fail("missing_test_user");
    userId = created.data.user.id;

    const profile = await supabase
      .from("profiles")
      .update({
        plan: "free",
        locale: "en",
        full_name: "ClipsFlow staging smoke test",
      })
      .eq("id", userId);
    await assertNoError("prepare_test_profile", profile);

    sourcePath = `${userId}/${runTag}.mp4`;
    const uploaded = await supabase.storage
      .from("clip-sources")
      .upload(sourcePath, source, {
        contentType: "video/mp4",
        upsert: false,
      });
    await assertNoError("upload_source", uploaded);

    const episode = await supabase
      .from("episodes")
      .insert({
        user_id: userId,
        title: "ClipsFlow Railway staging smoke test",
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
    submittedJobId = submitted.jobId;

    console.info(
      JSON.stringify({
        event: "staging_smoke_queued",
        run_tag: runTag,
        job_id: submitted.jobId,
      }),
    );

    const timeoutMs = Number(
      process.env.CLIPS_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    );
    const job = await waitForTerminalJob(supabase, submitted.jobId, timeoutMs);
    terminal = true;

    const clip = await supabase
      .from("clips")
      .select(
        "status, video_storage_path, captions_vtt_storage_path, error_message",
      )
      .eq("id", submitted.clipId)
      .single();
    await assertNoError("read_clip", clip);
    const renderedClip = clip.data as RenderedClip | null;
    if (
      !renderedClip ||
      job.status !== "completed" ||
      renderedClip.status !== "completed"
    ) {
      fail("render_did_not_complete");
    }
    if (
      !renderedClip.video_storage_path ||
      !renderedClip.captions_vtt_storage_path
    ) {
      fail("missing_render_artifacts");
    }
    outputPaths = [
      renderedClip.video_storage_path,
      renderedClip.captions_vtt_storage_path,
    ];

    const [mp4, vtt] = await Promise.all([
      supabase.storage
        .from("clip-outputs")
        .download(renderedClip.video_storage_path),
      supabase.storage
        .from("clip-outputs")
        .download(renderedClip.captions_vtt_storage_path),
    ]);
    await assertNoError("download_mp4", mp4);
    await assertNoError("download_vtt", vtt);
    if (!mp4.data || mp4.data.size === 0 || !vtt.data || vtt.data.size === 0) {
      fail("empty_render_artifact");
    }
    await assertDisclosureEvent(supabase, submitted.clipId);

    // A free profile routes through watermark-policy.  It is fail-closed in
    // the worker, therefore a completed render proves this mandatory stage
    // did not silently bypass or fail.
    console.info(
      JSON.stringify({
        event: "staging_smoke_render_verified",
        run_tag: runTag,
        attempts: job.attempt_count,
        mp4_bytes: mp4.data.size,
        vtt_bytes: vtt.data.size,
        free_watermark_path: "completed",
      }),
    );
  } finally {
    // If no job was accepted, no worker owns these data and cleanup is safe.
    // Once accepted, a timeout deliberately keeps the data intact so the
    // asynchronous worker can finish and the operator has a reproducible ID.
    if (userId && (!submittedJobId || terminal)) {
      await removeIfPresent(supabase, "clip-sources", [sourcePath]);
      await removeIfPresent(supabase, "clip-outputs", outputPaths);
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
          event: "staging_smoke_cleanup_verified",
          run_tag: runTag,
        }),
      );
    } else if (userId) {
      console.error(
        JSON.stringify({
          event: "staging_smoke_cleanup_deferred",
          run_tag: runTag,
          job_id: submittedJobId,
          reason: "non_terminal_job",
        }),
      );
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      event: "staging_smoke_failed",
      error: message.slice(0, 240),
    }),
  );
  process.exitCode = 1;
});
