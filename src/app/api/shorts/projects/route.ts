// ============================================================================
// ClipsFlow Shorts — project creation and private project history
// ============================================================================
// All reads and writes remain server-mediated because long-form transcripts,
// model outputs, and production choices must never be exposed through the
// Supabase Data API. The SQL RPC owns the transactional project + queue write.
// ============================================================================

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { resolvePlan } from "@/lib/clips/quota";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import {
  createShortsProjectSchema,
  type ShortsAnalysisMode,
} from "@/lib/shorts/project-contract";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import { resolveShortsVisualConfig } from "@/lib/shorts/visual-analysis";
import { resolveShortsAnalysisQuotaSeconds } from "@/lib/shorts/analysis-quota";

export const runtime = "nodejs";
export const maxDuration = 30;

const projectStatusSchema = z.enum([
  "draft",
  "queued",
  "transcribing",
  "analyzing",
  "ready",
  "failed",
]);

type PublicProjectSummary = Readonly<{
  id: string;
  episode_id: string;
  analysis_mode: ShortsAnalysisMode;
  duration_seconds: number | null;
  status: z.infer<typeof projectStatusSchema>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && z.uuid().safeParse(value).success;
}

function toPublicProjectSummary(value: unknown): PublicProjectSummary | null {
  const row = asRecord(value);
  if (!row) return null;
  const sourceDuration = row.source_duration_seconds;

  const status = projectStatusSchema.safeParse(row.status);
  if (
    !isUuid(row.id) ||
    !isUuid(row.episode_id) ||
    (row.analysis_mode !== "audio" && row.analysis_mode !== "audio_video") ||
    !status.success ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    (row.completed_at !== null && typeof row.completed_at !== "string") ||
    (sourceDuration !== null &&
      (typeof sourceDuration !== "number" ||
        !Number.isInteger(sourceDuration) ||
        sourceDuration < 0))
  ) {
    return null;
  }

  return {
    id: row.id,
    episode_id: row.episode_id,
    analysis_mode: row.analysis_mode,
    duration_seconds:
      typeof sourceDuration === "number" ? sourceDuration : null,
    status: status.data,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

async function isShortsEnabledForCurrentUser(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  return isClipsEnabled({ locale, userId });
}

function analysisBudgetIsAuthorized(): boolean {
  return process.env.CLIPS_AI_BUDGET_AUTHORIZED === "true";
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "analysis_temporarily_unavailable", retry_after_seconds: 300 },
    { status: 503, headers: { "Retry-After": "300" } },
  );
}

function logSubmissionFailure(stage: string, error?: unknown): void {
  const details = asRecord(error);
  const code = details?.code;
  const status = details?.status;
  console.error(
    JSON.stringify({
      level: "error",
      source: "api-shorts-projects",
      message: "analysis project submission failed",
      failure_stage: stage,
      ...(typeof code === "string" && /^[a-z0-9_.-]{1,40}$/iu.test(code)
        ? { error_code: code }
        : {}),
      ...(typeof status === "number" && Number.isInteger(status)
        ? { error_status: status }
        : {}),
    }),
  );
}

function firstRpcRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  return asRecord(data[0]);
}

function submissionError(errorCode: unknown): NextResponse | null {
  switch (errorCode) {
    case "episode_not_found":
    case "episode_not_ready":
      return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
    case "idempotency_conflict":
      return NextResponse.json(
        { error: "idempotency_conflict" },
        { status: 409 },
      );
    case "budget_exceeded":
    case "budget_unconfigured":
    case "analysis_quota_unconfigured":
      return unavailableResponse();
    case "analysis_quota_exceeded":
      return NextResponse.json(
        { error: "analysis_quota_exceeded" },
        { status: 402, headers: { "Cache-Control": "private, no-store" } },
      );
    default:
      return null;
  }
}

/**
 * Lists compact project metadata only. Deliberately omitted: raw transcript,
 * AI analysis payload, provider model configuration, errors, and all OAuth
 * data. A project detail endpoint returns only user-safe candidate fields.
 */
export async function GET(): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await isShortsEnabledForCurrentUser(user.id))) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: "projects_unavailable" },
      { status: 503 },
    );
  }

  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `shorts-project-list:${user.id}`,
      60,
      60,
    );
  } catch {
    return NextResponse.json(
      { error: "rate_limit_unavailable" },
      { status: 503 },
    );
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
      },
    );
  }

  const { data, error } = await admin
    .from("shorts_projects")
    .select(
      "id, episode_id, analysis_mode, source_duration_seconds, status, created_at, updated_at, completed_at",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    return NextResponse.json(
      { error: "projects_unavailable" },
      { status: 503 },
    );
  }

  const projects = (data ?? []).flatMap((row) => {
    const project = toPublicProjectSummary(row);
    return project ? [project] : [];
  });
  return NextResponse.json(
    { data: projects },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * Creates one idempotent long-form analysis request. No model is invoked in
 * the request lifecycle; the future `shorts_submit_analysis_job` SQL RPC
 * persists the project and queues the worker transactionally.
 */
export async function POST(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await isShortsEnabledForCurrentUser(user.id))) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }
  if (!analysisBudgetIsAuthorized()) {
    return unavailableResponse();
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    logSubmissionFailure("admin_client");
    return unavailableResponse();
  }

  // Long-form media can consume a meaningful provider budget. Keep the
  // browser retry-friendly, but make burst submissions fail closed.
  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `shorts-project-submit:${user.id}`,
      4,
      600,
    );
  } catch (error) {
    logSubmissionFailure("rate_limit", error);
    return NextResponse.json(
      { error: "rate_limit_unavailable" },
      { status: 503 },
    );
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = createShortsProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }
  if (parsed.data.analysis_mode === "audio_video") {
    try {
      resolveShortsVisualConfig();
    } catch (error) {
      logSubmissionFailure("visual_config", error);
      return unavailableResponse();
    }
    const { data: episode, error: episodeError } = await admin
      .from("episodes")
      .select("id, source_type, source_storage_path, source_url, status")
      .eq("id", parsed.data.episode_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (episodeError) {
      logSubmissionFailure("audio_video_episode_read", episodeError);
      return unavailableResponse();
    }
    if (!episode || episode.status !== "ready") {
      return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
    }
    const sourceUrlPath =
      typeof episode.source_url === "string"
        ? (() => {
            try {
              return new URL(episode.source_url).pathname.toLowerCase();
            } catch {
              return "";
            }
          })()
        : "";
    const sourcePath =
      typeof episode.source_storage_path === "string"
        ? episode.source_storage_path.toLowerCase()
        : sourceUrlPath;
    if (/\.(?:mp3|m4a|wav|aac|flac|ogg)$/u.test(sourcePath)) {
      return NextResponse.json(
        { error: "audio_video_requires_video_source" },
        { status: 400 },
      );
    }
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("plan")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError || !profile) {
    logSubmissionFailure("profile_read", profileError);
    return unavailableResponse();
  }
  const monthlyQuotaSeconds = resolveShortsAnalysisQuotaSeconds(
    resolvePlan(profile),
  );
  if (monthlyQuotaSeconds === null) {
    logSubmissionFailure("monthly_quota_configuration");
    return unavailableResponse();
  }

  const { data, error } = await admin.rpc(
    "shorts_submit_analysis_job_with_quota",
    {
      p_user_id: user.id,
      p_episode_id: parsed.data.episode_id,
      p_analysis_mode: parsed.data.analysis_mode,
      p_duration_seconds: parsed.data.duration_seconds,
      p_user_instructions: parsed.data.instructions,
      p_jev_shadow_consent: parsed.data.jev_shadow_consent,
      p_idempotency_key: parsed.data.idempotency_key,
      p_quota_limit_source_seconds: monthlyQuotaSeconds,
    },
  );
  if (error) {
    logSubmissionFailure("analysis_rpc", error);
    return unavailableResponse();
  }

  const result = firstRpcRow(data);
  if (!result) {
    logSubmissionFailure("invalid_analysis_rpc_result");
    return unavailableResponse();
  }

  const knownError = submissionError(result.error_code);
  if (knownError) return knownError;
  if (result.error_code !== null && result.error_code !== undefined) {
    logSubmissionFailure("unknown_analysis_rpc_result", {
      code: result.error_code,
    });
    return unavailableResponse();
  }

  const status = projectStatusSchema.safeParse(result.status);
  if (!isUuid(result.project_id) || !status.success) {
    logSubmissionFailure("invalid_project_summary");
    return unavailableResponse();
  }

  // The worker job is intentionally opaque to the browser. It is useful for
  // polling correlation, but can never grant access to another user's data.
  const jobId = isUuid(result.job_id) ? result.job_id : null;
  if (
    (status.data === "queued" ||
      status.data === "transcribing" ||
      status.data === "analyzing") &&
    !jobId
  ) {
    logSubmissionFailure("missing_analysis_job_id");
    return unavailableResponse();
  }

  return NextResponse.json(
    {
      data: {
        project_id: result.project_id,
        job_id: jobId,
        status: status.data,
      },
    },
    {
      status: status.data === "ready" || status.data === "failed" ? 200 : 202,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
