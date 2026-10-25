import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  hasCachedShortsAudioAsset,
  resolveShortsMotionEffect,
  resolveShortsMusicPrompt,
} from "@/lib/clips/elevenlabs-render";
import {
  CreativeDirectorError,
  resolveCreativeDirectorConfig,
} from "@/lib/clips/creative-director";
import { CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED } from "@/lib/clips/creative-director-model";
import { isClipsEnabled, isClipsWorkerEnabled } from "@/lib/clips/feature-flag";
import { resolvePlan, stripCustomizationsByPlan } from "@/lib/clips/quota";
import { SubmitClipJobError, submitClipJob } from "@/lib/clips/submit-job";
import { transcriptWindow } from "@/lib/clips/transcript-window";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import {
  shortsMusicMoodSchema,
  shortsProductionProfileSchema,
} from "@/lib/shorts/project-contract";
import {
  canRenderShortsWithAudioProfile,
  shortsMotionAnimationSpeed,
  shortsRenderRequestId,
  shortsTitleCardOverlay,
} from "@/lib/shorts/render-submission";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.strictObject({
  candidate_ids: z.array(z.uuid()).min(1).max(12),
});

type RouteContext = { params: Promise<{ projectId: string }> };

function unavailableResponse(error = "rendering_temporarily_unavailable") {
  return NextResponse.json(
    { error, retry_after_seconds: 300 },
    { status: 503, headers: { "Retry-After": "300" } },
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && z.uuid().safeParse(value).success;
}

/**
 * Queue selected candidate windows through the existing Clips quota and
 * render pipeline. Every item has a stable idempotency key, so a retried
 * batch safely returns already-created jobs instead of billing twice.
 */
export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { projectId } = await params;
  if (!isUuid(projectId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (!isClipsEnabled({ locale, userId: user.id })) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }
  if (!isClipsWorkerEnabled()) return unavailableResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
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
      `shorts-render:${user.id}`,
      6,
      60,
    );
  } catch {
    return unavailableResponse("rate_limit_unavailable");
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const { data: project, error: projectError } = await admin
    .from("shorts_projects")
    .select("id, episode_id, status, user_instructions")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (projectError) return unavailableResponse();
  if (!project)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (project.status !== "ready") {
    return NextResponse.json({ error: "project_not_ready" }, { status: 409 });
  }

  const requestedCandidateIds = parsedBody.data.candidate_ids;
  const { data: rows, error: candidateError } = await admin
    .from("shorts_candidates")
    .select(
      "id, episode_id, start_seconds, end_seconds, title, hook, music_mood, motion_direction, visual_summary, selected, production_profile",
    )
    .eq("project_id", project.id)
    .eq("user_id", user.id)
    .eq("selected", true)
    .in("id", requestedCandidateIds);
  if (candidateError) return unavailableResponse();

  const byId = new Map((rows ?? []).map((row) => [row.id as string, row]));
  const orderedRows = requestedCandidateIds.map((id) => byId.get(id));
  if (orderedRows.some((row) => !row) || orderedRows.length === 0) {
    return NextResponse.json(
      { error: "candidate_selection_conflict" },
      { status: 409 },
    );
  }

  const selectedCandidates = orderedRows.map((candidate) => {
    if (!candidate) return null;
    const productionProfile = shortsProductionProfileSchema.safeParse(
      candidate.production_profile,
    );
    return productionProfile.success
      ? { candidate, productionProfile: productionProfile.data }
      : null;
  });
  if (selectedCandidates.some((entry) => !entry)) {
    return NextResponse.json(
      { error: "production_profile_invalid" },
      { status: 409 },
    );
  }
  const candidatesWithProfiles = selectedCandidates.filter(
    (entry): entry is NonNullable<(typeof selectedCandidates)[number]> =>
      entry !== null,
  );
  if (
    candidatesWithProfiles.some(
      ({ productionProfile }) =>
        !canRenderShortsWithAudioProfile(productionProfile),
    )
  ) {
    return NextResponse.json(
      { error: "adapted_music_required" },
      { status: 409, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const hasCreativeDirection = candidatesWithProfiles.some(
    ({ productionProfile }) => productionProfile.creative_direction.enabled,
  );
  if (hasCreativeDirection) {
    if (!CLAUDE_OPUS_5_5_MODEL_API_ID_CONFIRMED) {
      return NextResponse.json(
        { error: "creative_director_model_unconfirmed" },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    try {
      // Configuration validation is local only. The provider is called once
      // by the fenced render worker after it has the selected clip transcript.
      resolveCreativeDirectorConfig();
    } catch (error) {
      const code =
        error instanceof CreativeDirectorError
          ? error.code
          : "creative_director_unavailable";
      return unavailableResponse(code);
    }
  }

  const { data: episode, error: episodeError } = await admin
    .from("episodes")
    .select("id, transcript_segments")
    .eq("id", project.episode_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (episodeError) return unavailableResponse();
  if (!episode) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }

  // A completed Shorts analysis already paid for and persisted word-level
  // timestamps on the source episode. Reuse them for rendering instead of
  // blocking on (or accidentally repeating) a hosted transcription call.
  // If any selected window lacks cached words, keep both paid-provider gates
  // closed until the caller has explicitly authorized a budget.
  const needsTranscription = candidatesWithProfiles.some(({ candidate }) => {
    const candidateWindow = candidate as {
      start_seconds: unknown;
      end_seconds: unknown;
    };
    return (
      transcriptWindow(
        episode.transcript_segments,
        candidateWindow.start_seconds as number,
        candidateWindow.end_seconds as number,
      ) === null
    );
  });
  if (needsTranscription) {
    if (process.env.CLIPS_AI_BUDGET_AUTHORIZED !== "true") {
      return unavailableResponse("paid_ai_not_authorized");
    }
    if (
      process.env.CLIPS_FORCE_OPENAI_WHISPER === "1"
        ? !process.env.OPENAI_API_KEY?.trim()
        : !process.env.GROQ_API_KEY?.trim() &&
          !process.env.OPENAI_API_KEY?.trim()
    ) {
      return unavailableResponse("transcription_unavailable");
    }
  }
  const audioAssetRequests = candidatesWithProfiles.flatMap(
    ({ candidate, productionProfile }) => {
      if (!productionProfile.elevenlabs.enabled) return [];
      const soundEffect = productionProfile.elevenlabs.use_cases.includes(
        "sound_effects",
      )
        ? resolveShortsMotionEffect(productionProfile.motion.template)
        : null;
      const audioCandidate = candidate as {
        id: string;
        title: string;
        hook: string;
        music_mood: string;
      };
      return [
        {
          userId: user.id,
          projectId: project.id,
          candidateId: audioCandidate.id,
          kind: "music" as const,
          prompt: resolveShortsMusicPrompt(
            audioCandidate.title,
            audioCandidate.hook,
            productionProfile.motion.template,
            audioCandidate.music_mood,
          ),
        },
        ...(soundEffect
          ? [
              {
                userId: user.id,
                projectId: project.id,
                candidateId: audioCandidate.id,
                kind: "sound_effect" as const,
                prompt: soundEffect.prompt,
              },
            ]
          : []),
      ];
    },
  );
  let needsElevenLabsGeneration = false;
  if (audioAssetRequests.length > 0) {
    let cachedAssets: boolean[];
    try {
      cachedAssets = await Promise.all(
        audioAssetRequests.map((asset) =>
          hasCachedShortsAudioAsset(admin, asset),
        ),
      );
    } catch {
      return unavailableResponse("elevenlabs_cache_unavailable");
    }
    needsElevenLabsGeneration = cachedAssets.some((cached) => !cached);
  }
  if (needsElevenLabsGeneration || hasCreativeDirection) {
    if (process.env.CLIPS_AI_BUDGET_AUTHORIZED !== "true") {
      return unavailableResponse("paid_ai_not_authorized");
    }
    if (needsElevenLabsGeneration) {
      try {
        const { resolveElevenLabsConfig } =
          await import("@/lib/clips/elevenlabs");
        resolveElevenLabsConfig();
      } catch {
        return unavailableResponse("elevenlabs_temporarily_unavailable");
      }
    }
  }

  const { data: accountProfile, error: accountProfileError } = await admin
    .from("profiles")
    .select("plan")
    .eq("id", user.id)
    .maybeSingle();
  if (accountProfileError || !accountProfile) {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }
  const plan = resolvePlan(accountProfile);
  const results: Array<{
    candidate_id: string;
    clip_id?: string;
    job_id?: string;
    status: "queued" | "failed";
    error?: string;
  }> = [];

  for (const { candidate, productionProfile } of candidatesWithProfiles) {
    const candidateId = candidate.id as string;
    if (
      candidate.episode_id !== project.episode_id ||
      !Number.isInteger(candidate.start_seconds) ||
      !Number.isInteger(candidate.end_seconds) ||
      typeof candidate.title !== "string" ||
      typeof candidate.hook !== "string" ||
      !shortsMusicMoodSchema.safeParse(candidate.music_mood).success ||
      typeof candidate.motion_direction !== "string" ||
      candidate.motion_direction.length < 1 ||
      candidate.motion_direction.length > 160
    ) {
      results.push({
        candidate_id: candidateId,
        status: "failed",
        error: "candidate_invalid",
      });
      continue;
    }

    const baseCustomizations = stripCustomizationsByPlan(plan, {
      auto_emphasis: productionProfile.subtitles.auto_emphasis,
      animation_speed: shortsMotionAnimationSpeed(
        productionProfile.motion.template,
        productionProfile.motion.reduced_motion,
      ),
    });
    const customizations = {
      ...baseCustomizations,
      shorts: {
        project_id: project.id,
        candidate_id: candidateId,
        title: candidate.title.slice(0, 120),
        hook: candidate.hook.slice(0, 280),
        music_mood: candidate.music_mood,
        motion_direction: candidate.motion_direction,
        motion_template: productionProfile.motion.template,
        reduced_motion: productionProfile.motion.reduced_motion,
        elevenlabs: productionProfile.elevenlabs,
        creative_direction: {
          ...productionProfile.creative_direction,
          user_instructions: productionProfile.creative_direction.enabled
            ? (project.user_instructions ?? "").slice(0, 1_200)
            : "",
          visual_summary:
            productionProfile.creative_direction.enabled &&
            typeof candidate.visual_summary === "string"
              ? candidate.visual_summary.slice(0, 1_200)
              : null,
        },
      },
    };
    const durationSeconds = candidate.end_seconds - candidate.start_seconds;
    const titleCard = shortsTitleCardOverlay(
      candidate.title,
      candidate.hook,
      durationSeconds,
      productionProfile.motion.template,
    );
    const overlays = titleCard ? [titleCard] : [];

    try {
      const submitted = await submitClipJob(admin, {
        userId: user.id,
        episodeId: project.episode_id,
        startSeconds: candidate.start_seconds,
        endSeconds: candidate.end_seconds,
        styleKey: productionProfile.subtitle_style,
        aspectRatio: productionProfile.aspect_ratio,
        language: "auto",
        customizations,
        overlays,
        requestId: shortsRenderRequestId(
          project.id,
          candidateId,
          productionProfile,
        ),
      });
      results.push({
        candidate_id: candidateId,
        clip_id: submitted.clipId,
        job_id: submitted.jobId,
        status: "queued",
      });
    } catch (error) {
      const code =
        error instanceof SubmitClipJobError ? error.code : "submit_failed";
      results.push({
        candidate_id: candidateId,
        status: "failed",
        error: code,
      });
      if (
        code === "profile_not_found" ||
        code === "episode_not_found" ||
        code === "submit_failed"
      ) {
        console.error(
          JSON.stringify({
            level: "error",
            source: "api-shorts-render",
            message: "candidate_render_submission_failed",
            candidate_id: candidateId,
            error_code: code,
          }),
        );
      }
    }
  }

  const queuedCount = results.filter(
    (result) => result.status === "queued",
  ).length;
  return NextResponse.json(
    { data: { project_id: project.id, queued_count: queuedCount, results } },
    {
      status: 202,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
