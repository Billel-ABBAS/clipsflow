/**
 * Controlled ClipsFlow staging render smoke test.
 *
 * It reads only the staging URL, public key, and server key it needs from
 * CLIPS_SMOKE_ENV_FILE, creates a throwaway confirmed user, and removes the
 * generated storage objects and auth user after a terminal job state. The
 * test signs in only that synthetic user to verify the owner-scoped gallery.
 * No credential, signed URL, transcript, or source media is ever logged.
 *
 * Required environment variables:
 *   CLIPS_SMOKE_ENV_FILE   Absolute path to an env file for staging.
 *   CLIPS_SMOKE_SOURCE     Absolute path to a short spoken MP4 fixture.
 *
 * Required:
 *   CLIPS_SMOKE_EXPECTED_REF  Must equal the authorized Billel project ref.
 *   CLIPS_SMOKE_ALLOW_PRODUCTION_DATA_WRITES=true
 *                             Explicit opt-in: this target Supabase project
 *                             is production and receives temporary test rows.
 *
 * Optional:
 *   CLIPS_SMOKE_TIMEOUT_MS    Queue wait timeout (default: 15 minutes).
 *   CLIPS_SMOKE_ARTIFACT_DIR  Save the synthetic MP4/VTT locally for review.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CLIP_SELECT_COLUMNS,
  toGalleryRow,
  type ClipRowRaw,
} from "../src/components/clips/clip-rows";
import {
  assertAuthorizedRenderTestRef,
  assertProductionTestDataWriteOptIn,
  isStagingBudgetGuardReady,
  STAGING_RENDER_BUDGET_CAP_USD,
  validateStagingSupabaseUrl,
} from "../src/lib/security/staging-smoke-config";
import { refreshClipUrls } from "../src/lib/clips/refresh-urls";
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
  const expectedRef = process.env.CLIPS_SMOKE_EXPECTED_REF;
  assertAuthorizedRenderTestRef(expectedRef);
  assertProductionTestDataWriteOptIn(
    process.env.CLIPS_SMOKE_ALLOW_PRODUCTION_DATA_WRITES,
  );

  const envFile = process.env.CLIPS_SMOKE_ENV_FILE;
  if (!envFile) fail("missing_env_file");
  const contents = await readFile(envFile, "utf8");
  const url = envValue(contents, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = envValue(contents, "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) fail("missing_staging_supabase_settings");

  const validatedUrl = validateStagingSupabaseUrl(url, expectedRef);

  return createClient(validatedUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function loadStagingGalleryClient(): Promise<SupabaseClient> {
  const expectedRef = process.env.CLIPS_SMOKE_EXPECTED_REF;
  assertAuthorizedRenderTestRef(expectedRef);
  assertProductionTestDataWriteOptIn(
    process.env.CLIPS_SMOKE_ALLOW_PRODUCTION_DATA_WRITES,
  );

  const envFile = process.env.CLIPS_SMOKE_ENV_FILE;
  if (!envFile) fail("missing_env_file");
  const contents = await readFile(envFile, "utf8");
  const url = envValue(contents, "NEXT_PUBLIC_SUPABASE_URL");
  const anonKey =
    envValue(contents, "NEXT_PUBLIC_SUPABASE_ANON_KEY") ??
    envValue(contents, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !anonKey) fail("missing_staging_public_supabase_settings");

  const validatedUrl = validateStagingSupabaseUrl(url, expectedRef);

  return createClient(validatedUrl, anonKey, {
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
  if (result.error) {
    const error = result.error as {
      code?: unknown;
      name?: unknown;
      status?: unknown;
    };
    const code =
      typeof error.code === "string"
        ? error.code
        : typeof error.name === "string"
          ? error.name
          : "unknown";
    const status =
      typeof error.status === "number" ? `_http_${error.status}` : "";
    fail(`${operation}_failed_${code}${status}`);
  }
}

async function assertStagingBudgetGuard(
  supabase: SupabaseClient,
): Promise<void> {
  const guard = await supabase
    .from("clips_budget_guard")
    .select("enabled, monthly_budget_usd")
    .eq("singleton", true)
    .maybeSingle();
  await assertNoError("read_staging_budget_guard", guard);
  if (
    !isStagingBudgetGuardReady(
      guard.data?.enabled,
      guard.data?.monthly_budget_usd,
    )
  ) {
    fail(
      `staging_budget_guard_must_be_enabled_at_or_below_usd_${STAGING_RENDER_BUDGET_CAP_USD.toFixed(2)}`,
    );
  }
}

async function assertNoActiveRenderJobs(
  supabase: SupabaseClient,
): Promise<void> {
  const active = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("type", "render")
    .in("status", ["pending", "processing"]);
  await assertNoError("read_active_render_jobs", active);
  if (active.count !== 0) fail("staging_queue_not_idle");
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
  const galleryClient = await loadStagingGalleryClient();
  // Fail closed before creating any synthetic auth, episode, clip, or job rows.
  await assertStagingBudgetGuard(supabase);
  await assertNoActiveRenderJobs(supabase);
  const runTag = `railway-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const email = `${runTag}@example.invalid`;
  const password = `${randomUUID()}aA9!`;
  let userId: string | null = null;
  let accessToken: string | null = null;
  let sourcePath: string | null = null;
  let outputPaths: Array<string | null> = [];
  let submittedJobId: string | null = null;
  let terminal = false;

  try {
    const created = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "ClipsFlow staging smoke test" },
    });
    await assertNoError("create_test_user", created);
    if (!created.data.user) fail("missing_test_user");
    userId = created.data.user.id;

    const signedIn = await galleryClient.auth.signInWithPassword({
      email,
      password,
    });
    await assertNoError("sign_in_gallery_test_user", signedIn);
    if (
      !signedIn.data.user ||
      signedIn.data.user.id !== userId ||
      !signedIn.data.session?.access_token
    ) {
      fail("gallery_test_user_session_missing");
    }
    accessToken = signedIn.data.session.access_token;

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
      startSeconds: 0,
      endSeconds: 12,
      styleKey: "viral",
      aspectRatio: "9:16",
      // Keep the detected source language to avoid an unnecessary paid
      // subtitle-translation call during this smoke test.
      language: "auto",
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

    // Optional local copies let an operator visually verify the rendered
    // watermark and captions before remote staging rows and objects are cleaned.
    const artifactDir = process.env.CLIPS_SMOKE_ARTIFACT_DIR;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      const mp4Path = join(artifactDir, `${runTag}.mp4`);
      const vttPath = join(artifactDir, `${runTag}.vtt`);
      await Promise.all([
        writeFile(mp4Path, Buffer.from(await mp4.data.arrayBuffer()), {
          flag: "wx",
        }),
        writeFile(vttPath, Buffer.from(await vtt.data.arrayBuffer()), {
          flag: "wx",
        }),
      ]);
      console.info(
        JSON.stringify({
          event: "staging_smoke_artifacts_saved",
          mp4_file: mp4Path,
          vtt_file: vttPath,
        }),
      );
    }

    await assertDisclosureEvent(supabase, submitted.clipId);

    // Exercise the same owner-scoped Data API read, signed-URL refresh, and
    // row mapping used by the /clips gallery page, not only service-role IO.
    const galleryQuery = await galleryClient
      .from("clips")
      .select(CLIP_SELECT_COLUMNS)
      .eq("id", submitted.clipId)
      .eq("user_id", userId)
      .single();
    await assertNoError("read_gallery_clip_as_owner", galleryQuery);
    const [refreshedGalleryRaw] = await refreshClipUrls(galleryClient, [
      galleryQuery.data as unknown as ClipRowRaw,
    ]);
    const galleryClip = toGalleryRow(refreshedGalleryRaw);
    if (
      galleryClip.status !== "completed" ||
      !galleryClip.video_url ||
      !galleryClip.captions_vtt_url
    ) {
      fail("gallery_row_missing_render_urls");
    }
    const [galleryVideoResponse, galleryVttResponse] = await Promise.all([
      fetch(galleryClip.video_url),
      fetch(galleryClip.captions_vtt_url),
    ]);
    if (!galleryVideoResponse.ok || !galleryVttResponse.ok) {
      fail("gallery_signed_url_fetch_failed");
    }
    const [galleryVideoBytes, galleryVttBytes] = await Promise.all([
      galleryVideoResponse.arrayBuffer(),
      galleryVttResponse.arrayBuffer(),
    ]);
    if (
      galleryVideoBytes.byteLength === 0 ||
      galleryVttBytes.byteLength === 0
    ) {
      fail("gallery_signed_url_artifact_empty");
    }
    console.info(
      JSON.stringify({
        event: "staging_smoke_gallery_verified",
        run_tag: runTag,
        authenticated_owner_read: true,
        signed_mp4_bytes: galleryVideoBytes.byteLength,
        signed_vtt_bytes: galleryVttBytes.byteLength,
      }),
    );

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
      if (accessToken) {
        const revoked = await supabase.auth.admin.signOut(accessToken);
        await assertNoError("revoke_gallery_test_session", revoked);
        accessToken = null;
      }
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
