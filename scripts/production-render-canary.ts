/**
 * One-shot ClipsFlow production render canary.
 *
 * Effects when explicitly invoked:
 * - creates one confirmed synthetic Auth user at example.invalid (free plan);
 * - uploads the pinned synthetic fixture, inserts one 12-second episode and
 *   submits exactly one render through the budget-guarded RPC;
 * - the Railway worker processes it (this script never renders locally);
 * - after a terminal state, removes the synthetic Storage objects and user,
 *   then verifies the related rows and files are gone.
 *
 * On timeout or uncertain job acceptance, it deliberately retains the test
 * data and prints only the synthetic user/job IDs for safe reconciliation.
 * It requires an explicit --confirm-production flag and an exact production
 * Supabase project-ref assertion; it never reads a local env file.
 *
 * Expected cost estimate for the 12-second canary: USD 0.002968. The script
 * requires the database guard to be enabled at or below USD 10, with enough
 * remaining headroom for the estimate, and the render queue to be empty before
 * it creates any data. The RPC re-checks the budget atomically.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { computeClipCost } from "../src/lib/clips/cost";
import { getProductionCanaryBudgetFailure } from "../src/lib/clips/production-canary-budget";
import { submitClipJob } from "../src/lib/clips/submit-job";

// `ifwdzqzoqwitahffrvcr` is the Supabase project promoted from controlled
// staging to ClipsFlow production. Keep this assertion exact: a production
// canary must never run against a similarly named project by accident.
const EXPECTED_PROJECT_REF = "ifwdzqzoqwitahffrvcr";
const EXPECTED_FIXTURE_NAME = "clipsflow-staging-render-test.mp4";
const EXPECTED_FIXTURE_BYTES = 77_994;
const EXPECTED_FIXTURE_SHA256 =
  "1459dc39a3f45c49a31ed3a3ba68761f5d1f88274c1f4f2860ca949d1edbee00";
const CANARY_DURATION_SECONDS = 12;
const POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

type JobRow = {
  id: string;
  status: string;
  clip_id: string | null;
  attempt_count: number;
};

type ClipRow = {
  status: string;
  cost_usd: number | string | null;
  video_storage_path: string | null;
  captions_vtt_storage_path: string | null;
};

type StorageEntry = { id: string | null; name: string };

function fail(message: string): never {
  throw new Error(`production_render_canary:${message}`);
}

function parseArgs(args: string[]): { sourcePath: string } {
  if (args.length === 1 && args[0] === "--help") {
    console.info(
      "Usage: pnpm exec tsx scripts/production-render-canary.ts --confirm-production --source <pinned-synthetic-mp4>",
    );
    process.exit(0);
  }
  if (
    args.length !== 3 ||
    args[0] !== "--confirm-production" ||
    args[1] !== "--source" ||
    !args[2]
  ) {
    fail("explicit_confirmation_and_source_required");
  }
  return { sourcePath: resolve(args[2]) };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing_${name.toLowerCase()}`);
  return value;
}

function createProductionClient(): SupabaseClient {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") fail("supabase_url_not_https");
    hostname = parsed.hostname;
  } catch {
    fail("invalid_supabase_url");
  }
  if (hostname !== `${EXPECTED_PROJECT_REF}.supabase.co`) {
    fail("unexpected_supabase_project_ref");
  }

  if (process.env.CLIPS_WORKER_ENABLED !== "true") {
    fail("production_worker_not_enabled");
  }
  if (process.env.CLIPS_AI_BUDGET_AUTHORIZED !== "true") {
    fail("paid_ai_budget_not_authorized");
  }
  if (!process.env.GROQ_API_KEY?.trim()) fail("groq_provider_not_configured");
  if (process.env.CLIPS_FORCE_OPENAI_WHISPER === "1") {
    fail("openai_whisper_forced_refusing_canary");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function assertNoError(
  operation: string,
  result: { error: { message: string } | null },
): void {
  if (result.error) fail(`${operation}_failed`);
}

async function validateFixture(sourcePath: string): Promise<Buffer> {
  if (basename(sourcePath) !== EXPECTED_FIXTURE_NAME) {
    fail("unexpected_fixture_name");
  }
  if (!sourcePath.toLowerCase().includes(".tmp-staging-render-test")) {
    fail("fixture_must_be_the_pinned_synthetic_test_asset");
  }
  const [source, sourceStats] = await Promise.all([
    readFile(sourcePath),
    stat(sourcePath),
  ]);
  if (sourceStats.size !== EXPECTED_FIXTURE_BYTES) {
    fail("unexpected_fixture_size");
  }
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== EXPECTED_FIXTURE_SHA256) fail("unexpected_fixture_hash");
  return source;
}

async function assertBudgetAndQueue(supabase: SupabaseClient): Promise<void> {
  const guard = await supabase
    .from("clips_budget_guard")
    .select("enabled, monthly_budget_usd")
    .eq("singleton", true)
    .maybeSingle();
  assertNoError("read_budget_guard", guard);

  const activeJobs = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("type", "render")
    .in("status", ["pending", "processing"]);
  assertNoError("check_empty_render_queue", activeJobs);
  if (activeJobs.count !== 0) fail("render_queue_not_empty");

  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const completed = await supabase
    .from("clips")
    .select("cost_usd")
    .eq("status", "completed")
    .gte("completed_at", monthStart.toISOString());
  assertNoError("read_monthly_completed_cost", completed);
  const spent = (completed.data ?? []).reduce((total, row) => {
    const value = Number(row.cost_usd ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      fail("invalid_monthly_cost_data");
    }
    return total + value;
  }, 0);
  const canaryEstimate = computeClipCost(CANARY_DURATION_SECONDS);
  const budgetFailure = getProductionCanaryBudgetFailure({
    guardEnabled: guard.data?.enabled,
    monthlyBudgetUsd: guard.data?.monthly_budget_usd,
    monthlySpendUsd: spent,
    estimatedCostUsd: canaryEstimate,
  });
  if (budgetFailure) {
    fail(budgetFailure);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitForTerminalJob(
  supabase: SupabaseClient,
  jobId: string,
  timeoutMs: number,
): Promise<JobRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await supabase
      .from("jobs")
      .select("id, status, clip_id, attempt_count")
      .eq("id", jobId)
      .single();
    assertNoError("read_render_job", result);
    const job = result.data as JobRow | null;
    if (!job) fail("render_job_missing");
    if (job.status === "completed" || job.status === "failed") return job;
    await sleep(POLL_INTERVAL_MS);
  }
  fail("worker_timeout_test_data_retained");
}

async function listUserObjects(
  supabase: SupabaseClient,
  bucket: "clip-sources" | "clip-outputs",
  userId: string,
): Promise<string[]> {
  const pendingFolders = [userId];
  const objectPaths: string[] = [];
  while (pendingFolders.length > 0) {
    const folder = pendingFolders.pop();
    if (!folder) continue;
    const page = await supabase.storage.from(bucket).list(folder, {
      limit: 100,
      offset: 0,
    });
    assertNoError(`list_${bucket}_for_cleanup`, page);
    const entries = (page.data ?? []) as StorageEntry[];
    if (entries.length >= 100) fail(`cleanup_listing_limit_${bucket}`);
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (entry.id === null) pendingFolders.push(path);
      else objectPaths.push(path);
    }
  }
  return objectPaths;
}

async function clearBucketForUser(
  supabase: SupabaseClient,
  bucket: "clip-sources" | "clip-outputs",
  userId: string,
): Promise<void> {
  const paths = await listUserObjects(supabase, bucket, userId);
  if (paths.some((path) => !path.startsWith(`${userId}/`))) {
    fail(`unsafe_storage_path_${bucket}`);
  }
  if (paths.length > 0) {
    const removal = await supabase.storage.from(bucket).remove(paths);
    assertNoError(`remove_${bucket}_objects`, removal);
  }
  const remaining = await listUserObjects(supabase, bucket, userId);
  if (remaining.length !== 0) fail(`residual_storage_objects_${bucket}`);
}

async function assertCountZero(
  supabase: SupabaseClient,
  table: "profiles" | "episodes" | "clips" | "jobs" | "ai_disclosure_events",
  userId: string,
): Promise<void> {
  const result = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(table === "profiles" ? "id" : "user_id", userId);
  assertNoError(`verify_${table}_cleanup`, result);
  if (result.count !== 0) fail(`residual_${table}`);
}

async function canCleanUpUser(
  supabase: SupabaseClient,
  userId: string,
  episodeId: string | null,
  knownJobId: string | null,
  runTag: string,
): Promise<{ safe: boolean; jobId: string | null; clipId: string | null }> {
  if (!episodeId) return { safe: true, jobId: null, clipId: null };
  const lookup = supabase
    .from("jobs")
    .select("id, status, clip_id, attempt_count")
    .eq("type", "render")
    .eq("user_id", userId)
    .eq("episode_id", episodeId);
  const result = knownJobId
    ? await lookup.eq("id", knownJobId).maybeSingle()
    : await lookup.maybeSingle();
  if (result.error) {
    console.error(
      JSON.stringify({
        event: "production_canary_cleanup_deferred",
        run_tag: runTag,
        user_id: userId,
        job_id: knownJobId,
        reason: "cannot_reconcile_render_state",
      }),
    );
    return { safe: false, jobId: knownJobId, clipId: null };
  }
  const job = result.data as JobRow | null;
  if (!job) {
    if (knownJobId) {
      console.error(
        JSON.stringify({
          event: "production_canary_cleanup_deferred",
          run_tag: runTag,
          user_id: userId,
          job_id: knownJobId,
          reason: "accepted_job_not_found",
        }),
      );
      return { safe: false, jobId: knownJobId, clipId: null };
    }
    return { safe: true, jobId: null, clipId: null };
  }
  const terminal = job.status === "completed" || job.status === "failed";
  if (!terminal) {
    console.error(
      JSON.stringify({
        event: "production_canary_cleanup_deferred",
        run_tag: runTag,
        user_id: userId,
        job_id: job.id,
        reason: "non_terminal_job",
      }),
    );
  }
  return { safe: terminal, jobId: job.id, clipId: job.clip_id };
}

async function cleanupCanary(
  supabase: SupabaseClient,
  userId: string,
  clipId: string | null,
  runTag: string,
): Promise<void> {
  if (clipId) {
    const clipResult = await supabase
      .from("clips")
      .select("status, video_storage_path, captions_vtt_storage_path")
      .eq("id", clipId)
      .eq("user_id", userId)
      .single();
    assertNoError("read_clip_before_cleanup", clipResult);
    const clip = clipResult.data as ClipRow | null;
    if (!clip) fail("clip_missing_before_cleanup");
    const expectedPrefix = `${userId}/${clipId}`;
    for (const path of [
      clip.video_storage_path,
      clip.captions_vtt_storage_path,
    ]) {
      if (
        path &&
        path !== `${expectedPrefix}.mp4` &&
        path !== `${expectedPrefix}.vtt` &&
        !path.startsWith(`${expectedPrefix}/attempts/`)
      ) {
        fail("unexpected_clip_storage_path");
      }
    }
  }

  await clearBucketForUser(supabase, "clip-sources", userId);
  await clearBucketForUser(supabase, "clip-outputs", userId);
  const deleted = await supabase.auth.admin.deleteUser(userId);
  assertNoError("delete_synthetic_auth_user", deleted);
  await Promise.all([
    assertCountZero(supabase, "profiles", userId),
    assertCountZero(supabase, "episodes", userId),
    assertCountZero(supabase, "clips", userId),
    assertCountZero(supabase, "jobs", userId),
    assertCountZero(supabase, "ai_disclosure_events", userId),
  ]);
  console.info(
    JSON.stringify({
      event: "production_canary_cleanup_verified",
      run_tag: runTag,
    }),
  );
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
  assertNoError("read_ai_disclosure_event", result);
  const metadata = result.data?.metadata as Record<string, unknown> | undefined;
  if (
    result.data?.clip_id !== clipId ||
    metadata?.content_kind !== "generated_subtitle_overlay"
  ) {
    fail("missing_or_invalid_ai_disclosure_event");
  }
}

async function main(): Promise<void> {
  const { sourcePath } = parseArgs(process.argv.slice(2));
  const source = await validateFixture(sourcePath);
  const supabase = createProductionClient();
  await assertBudgetAndQueue(supabase);

  const runTag = `prod-canary-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const email = `${runTag}@example.invalid`;
  let userId: string | null = null;
  let episodeId: string | null = null;
  let jobId: string | null = null;
  let clipId: string | null = null;
  let renderVerified = false;

  try {
    const created = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: "ClipsFlow production canary" },
    });
    assertNoError("create_synthetic_auth_user", created);
    if (!created.data.user) fail("synthetic_auth_user_missing");
    userId = created.data.user.id;

    const profile = await supabase
      .from("profiles")
      .update({ plan: "free", locale: "en", full_name: "ClipsFlow canary" })
      .eq("id", userId)
      .select("id, plan")
      .single();
    assertNoError("prepare_free_canary_profile", profile);
    if (profile.data?.id !== userId || profile.data.plan !== "free") {
      fail("free_canary_profile_not_confirmed");
    }

    const sourcePathInStorage = `${userId}/${runTag}.mp4`;
    const upload = await supabase.storage
      .from("clip-sources")
      .upload(sourcePathInStorage, source, {
        contentType: "video/mp4",
        upsert: false,
      });
    assertNoError("upload_synthetic_source", upload);

    const episode = await supabase
      .from("episodes")
      .insert({
        user_id: userId,
        title: "ClipsFlow production canary (synthetic)",
        source_type: "upload",
        source_storage_path: sourcePathInStorage,
        duration_seconds: 13,
        status: "ready",
      })
      .select("id")
      .single();
    assertNoError("create_synthetic_episode", episode);
    if (!episode.data?.id) fail("synthetic_episode_missing");
    const createdEpisodeId = episode.data.id;
    episodeId = createdEpisodeId;

    const submittedAt = Date.now();
    const submitted = await submitClipJob(supabase, {
      userId,
      episodeId: createdEpisodeId,
      startSeconds: 0,
      endSeconds: CANARY_DURATION_SECONDS,
      styleKey: "viral",
      aspectRatio: "9:16",
      language: "auto",
      customizations: {},
      overlays: [],
    });
    jobId = submitted.jobId;
    clipId = submitted.clipId;
    console.info(
      JSON.stringify({
        event: "production_canary_queued",
        run_tag: runTag,
        job_id: jobId,
        clip_id: clipId,
        estimated_cost_usd: computeClipCost(CANARY_DURATION_SECONDS),
      }),
    );

    const requestedTimeout = Number(
      process.env.CLIPS_PROD_CANARY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    );
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.min(Math.max(requestedTimeout, 60_000), 20 * 60_000)
      : DEFAULT_TIMEOUT_MS;
    const job = await waitForTerminalJob(supabase, jobId, timeoutMs);
    const queueToTerminalMs = Date.now() - submittedAt;
    if (job.status !== "completed") fail("render_failed_terminally");
    if (job.clip_id && job.clip_id !== clipId) fail("job_clip_mismatch");

    const clipResult = await supabase
      .from("clips")
      .select("status, cost_usd, video_storage_path, captions_vtt_storage_path")
      .eq("id", clipId)
      .eq("user_id", userId)
      .single();
    assertNoError("read_completed_canary_clip", clipResult);
    const clip = clipResult.data as ClipRow | null;
    if (clip?.status !== "completed") fail("clip_not_completed");
    const appCostEstimateUsd = Number(clip.cost_usd);
    if (!Number.isFinite(appCostEstimateUsd) || appCostEstimateUsd < 0) {
      fail("invalid_persisted_cost_estimate");
    }
    if (!clip.video_storage_path || !clip.captions_vtt_storage_path) {
      fail("mp4_or_vtt_path_missing");
    }
    const expectedPrefix = `${userId}/${clipId}`;
    if (
      (clip.video_storage_path !== `${expectedPrefix}.mp4` &&
        !clip.video_storage_path.startsWith(`${expectedPrefix}/attempts/`)) ||
      (clip.captions_vtt_storage_path !== `${expectedPrefix}.vtt` &&
        !clip.captions_vtt_storage_path.startsWith(
          `${expectedPrefix}/attempts/`,
        ))
    ) {
      fail("render_artifact_path_not_scoped_to_canary");
    }

    const [mp4, vtt] = await Promise.all([
      supabase.storage.from("clip-outputs").download(clip.video_storage_path),
      supabase.storage
        .from("clip-outputs")
        .download(clip.captions_vtt_storage_path),
    ]);
    assertNoError("download_canary_mp4", mp4);
    assertNoError("download_canary_vtt", vtt);
    if (!mp4.data || !vtt.data || mp4.data.size === 0 || vtt.data.size === 0) {
      fail("empty_mp4_or_vtt_artifact");
    }
    const mp4Bytes = Buffer.from(await mp4.data.arrayBuffer());
    if (mp4Bytes.length < 12 || mp4Bytes.toString("ascii", 4, 8) !== "ftyp") {
      fail("invalid_mp4_container");
    }
    const vttText = await vtt.data.text();
    const vttCueCount =
      vttText.match(
        /\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/g,
      )?.length ?? 0;
    if (!vttText.startsWith("WEBVTT") || vttCueCount === 0) {
      fail("invalid_vtt_artifact");
    }
    await assertDisclosureEvent(supabase, clipId);
    renderVerified = true;
    console.info(
      JSON.stringify({
        event: "production_canary_render_verified",
        run_tag: runTag,
        attempts: job.attempt_count,
        mp4_bytes: mp4.data.size,
        vtt_bytes: vtt.data.size,
        vtt_cue_count: vttCueCount,
        queue_to_terminal_ms: queueToTerminalMs,
        app_cost_estimate_usd: appCostEstimateUsd,
        cost_measurement: "application_estimate_not_vendor_invoice",
        profile_plan: "free",
        watermark_policy_path: "completed",
        transcription_provider: "groq_whisper_large_v3_turbo",
        translation: "disabled_by_auto_language",
      }),
    );
  } finally {
    if (userId) {
      let reconciliation: {
        safe: boolean;
        jobId: string | null;
        clipId: string | null;
      } | null = null;
      try {
        reconciliation = await canCleanUpUser(
          supabase,
          userId,
          episodeId,
          jobId,
          runTag,
        );
      } catch {
        console.error(
          JSON.stringify({
            event: "production_canary_cleanup_deferred",
            run_tag: runTag,
            user_id: userId,
            job_id: jobId,
            reason: "render_state_unavailable",
          }),
        );
        process.exitCode = 1;
      }
      if (reconciliation?.safe) {
        try {
          await cleanupCanary(
            supabase,
            userId,
            reconciliation.clipId ?? clipId,
            runTag,
          );
        } catch {
          console.error(
            JSON.stringify({
              event: "production_canary_cleanup_failed",
              run_tag: runTag,
              user_id: userId,
              job_id: reconciliation.jobId,
              reason: "manual_cleanup_required",
            }),
          );
          process.exitCode = 1;
        }
      } else if (reconciliation) {
        process.exitCode = 1;
      }
    }
  }

  if (!renderVerified) fail("render_not_verified");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      event: "production_canary_failed",
      error: message.slice(0, 240),
    }),
  );
  process.exitCode = 1;
});
