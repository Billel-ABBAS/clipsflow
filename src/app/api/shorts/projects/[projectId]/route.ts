// ============================================================================
// ClipsFlow Shorts — private project status and candidate selection
// ============================================================================
// Candidate selection uses one service-role-only SQL function, so ownership,
// readiness, candidate membership, and deselection happen atomically.
// ============================================================================

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import {
  selectShortsCandidatesSchema,
  shortsMusicMoodSchema,
  type ShortsAnalysisMode,
  type ShortsMusicMood,
} from "@/lib/shorts/project-contract";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";

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

type PublicProjectStatus = Readonly<{
  id: string;
  episode_id: string;
  analysis_mode: ShortsAnalysisMode;
  duration_seconds: number | null;
  status: z.infer<typeof projectStatusSchema>;
  analysis_quota_exceeded: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

type PublicCandidate = Readonly<{
  id: string;
  rank: number;
  start_seconds: number;
  end_seconds: number;
  score: number;
  hook: string;
  title: string;
  rationale: string;
  transcript_excerpt: string;
  music_mood: ShortsMusicMood;
  motion_direction: string;
  visual_summary: string | null;
  selected: boolean;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && z.uuid().safeParse(value).success;
}

function toPublicProjectStatus(value: unknown): PublicProjectStatus | null {
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
    analysis_quota_exceeded: row.error_message === "analysis_quota_exceeded",
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function toPublicCandidate(value: unknown): PublicCandidate | null {
  const row = asRecord(value);
  if (!row) return null;
  const musicMood = shortsMusicMoodSchema.safeParse(row.music_mood);
  if (
    !isUuid(row.id) ||
    typeof row.rank !== "number" ||
    !Number.isInteger(row.rank) ||
    typeof row.start_seconds !== "number" ||
    !Number.isInteger(row.start_seconds) ||
    typeof row.end_seconds !== "number" ||
    !Number.isInteger(row.end_seconds) ||
    typeof row.score !== "number" ||
    !Number.isInteger(row.score) ||
    row.rank < 1 ||
    row.start_seconds < 0 ||
    row.end_seconds <= row.start_seconds ||
    row.score < 0 ||
    row.score > 100 ||
    typeof row.hook !== "string" ||
    typeof row.title !== "string" ||
    typeof row.rationale !== "string" ||
    typeof row.transcript_excerpt !== "string" ||
    !musicMood.success ||
    typeof row.motion_direction !== "string" ||
    row.motion_direction.length < 1 ||
    row.motion_direction.length > 160 ||
    (row.visual_summary !== null && typeof row.visual_summary !== "string") ||
    typeof row.selected !== "boolean"
  ) {
    return null;
  }

  return {
    id: row.id,
    rank: row.rank,
    start_seconds: row.start_seconds,
    end_seconds: row.end_seconds,
    score: row.score,
    hook: row.hook,
    title: row.title,
    rationale: row.rationale,
    transcript_excerpt: row.transcript_excerpt,
    music_mood: musicMood.data,
    motion_direction: row.motion_direction,
    visual_summary: row.visual_summary,
    selected: row.selected,
  };
}

async function isShortsEnabledForCurrentUser(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  return isClipsEnabled({ locale, userId });
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "analysis_temporarily_unavailable", retry_after_seconds: 300 },
    { status: 503, headers: { "Retry-After": "300" } },
  );
}

function selectedCountFromRpc(data: unknown): number | null {
  if (typeof data === "number" && Number.isInteger(data)) return data;

  const row = Array.isArray(data) && data.length === 1 ? data[0] : data;
  const record = asRecord(row);
  if (!record) return null;
  const value =
    record.selected_count ?? record.shorts_set_selected_candidates ?? null;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

type RouteContext = { params: Promise<{ projectId: string }> };

/**
 * Returns only the creator-visible detail required to review candidate shorts.
 * Raw analysis payloads, provider prompts, billing values, storage paths, and
 * OAuth data are never selected from the database.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!(await isShortsEnabledForCurrentUser(user.id))) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "project_unavailable" }, { status: 503 });
  }

  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `shorts-project-status:${user.id}`,
      120,
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

  const { data: projectData, error: projectError } = await admin
    .from("shorts_projects")
    .select(
      "id, episode_id, analysis_mode, source_duration_seconds, status, error_message, created_at, updated_at, completed_at",
    )
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (projectError) {
    return NextResponse.json({ error: "project_unavailable" }, { status: 503 });
  }

  const project = toPublicProjectStatus(projectData);
  if (!project) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { data: candidateData, error: candidateError } = await admin
    .from("shorts_candidates")
    .select(
      "id, rank, start_seconds, end_seconds, score, hook, title, rationale, transcript_excerpt, music_mood, motion_direction, visual_summary, selected",
    )
    .eq("project_id", project.id)
    .eq("user_id", user.id)
    .order("rank", { ascending: true })
    .limit(24);
  if (candidateError) {
    return NextResponse.json({ error: "project_unavailable" }, { status: 503 });
  }

  const candidates = (candidateData ?? []).flatMap((row) => {
    const candidate = toPublicCandidate(row);
    return candidate ? [candidate] : [];
  });
  return NextResponse.json(
    { data: { project, candidates } },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * Atomically selects up to twelve candidates and resets every other candidate
 * in the same owned, ready project. The worker receives only a bounded
 * production profile; ElevenLabs is never called by this request.
 */
export async function PATCH(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!(await isShortsEnabledForCurrentUser(user.id))) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return unavailableResponse();
  }

  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `shorts-project-selection:${user.id}`,
      20,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = selectShortsCandidatesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }

  const { data, error } = await admin.rpc("shorts_set_selected_candidates", {
    p_user_id: user.id,
    p_project_id: projectId,
    p_candidate_ids: parsed.data.candidate_ids,
    p_production_profile: parsed.data.production_profile,
  });
  if (error) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-shorts-project-detail",
        message: "candidate selection failed",
      }),
    );
    return NextResponse.json(
      { error: "candidate_selection_unavailable" },
      { status: 503 },
    );
  }

  const selectedCount = selectedCountFromRpc(data);
  if (selectedCount === -1) {
    return NextResponse.json({ error: "project_not_ready" }, { status: 409 });
  }
  if (selectedCount !== parsed.data.candidate_ids.length) {
    return NextResponse.json(
      { error: "candidate_selection_conflict" },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      data: {
        project_id: projectId,
        selected_candidate_ids: parsed.data.candidate_ids,
        selected_count: selectedCount,
        reduced_motion: parsed.data.production_profile.motion.reduced_motion,
        elevenlabs_sound_design: {
          enabled: parsed.data.production_profile.elevenlabs.enabled,
          explicit_user_consent:
            parsed.data.production_profile.elevenlabs.explicit_consent,
          commercial_license_confirmed:
            parsed.data.production_profile.elevenlabs
              .commercial_license_confirmed,
        },
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
