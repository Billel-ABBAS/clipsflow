import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import {
  buildYouTubePublishRequestPayload,
  type YouTubePublishPrivacyStatus,
} from "@/lib/youtube/oauth";
import { apiError, isSameOriginMutation } from "@/lib/youtube/route-utils";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.strictObject({
  clip_id: z.uuid(),
  connection_id: z.uuid(),
  title: z.string().trim().min(1).max(100),
  description: z.string().max(5_000).optional().default(""),
  tags: z
    .array(z.string().trim().min(1).max(100))
    .max(15)
    .optional()
    .default([]),
  visibility: z.enum(["private", "unlisted", "public"]),
  confirm_public_intent: z.boolean(),
  made_for_kids: z.boolean(),
  contains_synthetic_media: z.boolean(),
  notify_subscribers: z.boolean().optional().default(false),
});

function isPrivacyStatus(value: unknown): value is YouTubePublishPrivacyStatus {
  return value === "private" || value === "unlisted" || value === "public";
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError("invalid_origin", 403);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return apiError("unauthorized", 401);
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (!isClipsEnabled({ locale, userId: user.id })) {
    return apiError("not_yet_available", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError("validation_error", 400);
  if (
    parsed.data.visibility === "public" &&
    parsed.data.confirm_public_intent !== true
  ) {
    return apiError("public_confirmation_required", 400);
  }
  if (
    parsed.data.visibility !== "private" &&
    process.env.YOUTUBE_PUBLIC_UPLOADS_ENABLED !== "true"
  ) {
    return apiError("visibility_not_available", 503);
  }
  let publishPayload;
  try {
    publishPayload = buildYouTubePublishRequestPayload({
      title: parsed.data.title,
      description: parsed.data.description,
      tags: parsed.data.tags,
      privacyStatus: parsed.data.visibility,
      confirmPublic: parsed.data.confirm_public_intent,
      notifySubscribers: parsed.data.notify_subscribers,
      madeForKids: parsed.data.made_for_kids,
    });
  } catch {
    return apiError("metadata_invalid", 400);
  }
  if (!isPrivacyStatus(publishPayload.body.status.privacyStatus)) {
    return apiError("metadata_invalid", 400);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return apiError("youtube_unavailable", 503);
  }
  const rateLimit = await checkDistributedRateLimit(
    admin,
    `youtube-publication-create:${user.id}`,
    10,
    600,
  ).catch(() => null);
  if (!rateLimit) return apiError("rate_limit_unavailable", 503);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
          "Cache-Control": "private, no-store",
        },
      },
    );
  }

  const [
    { data: clip, error: clipError },
    { data: connection, error: connectionError },
  ] = await Promise.all([
    admin
      .from("clips")
      .select("id, status, video_storage_path")
      .eq("id", parsed.data.clip_id)
      .eq("user_id", user.id)
      .maybeSingle(),
    admin
      .from("youtube_connections")
      .select("id, channel_title")
      .eq("id", parsed.data.connection_id)
      .eq("user_id", user.id)
      .eq("is_active", true)
      .is("disconnected_at", null)
      .not("refresh_token_ciphertext", "is", null)
      .maybeSingle(),
  ]);
  if (clipError || connectionError) return apiError("youtube_unavailable", 503);
  if (
    !clip ||
    clip.status !== "completed" ||
    typeof clip.video_storage_path !== "string" ||
    !clip.video_storage_path.startsWith(`${user.id}/`) ||
    !clip.video_storage_path.toLowerCase().endsWith(".mp4")
  ) {
    return apiError("clip_not_ready", 409);
  }
  if (!connection) return apiError("connection_not_found", 404);

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const now = Date.now();
  const expiresAt = new Date(now + 10 * 60 * 1_000).toISOString();
  const { data: publication, error } = await admin
    .from("shorts_publications")
    .insert({
      user_id: user.id,
      clip_id: clip.id,
      youtube_connection_id: connection.id,
      title: publishPayload.body.snippet.title,
      description: publishPayload.body.snippet.description,
      tags: publishPayload.body.snippet.tags ?? [],
      visibility: publishPayload.body.status.privacyStatus,
      made_for_kids: parsed.data.made_for_kids,
      contains_synthetic_media: parsed.data.contains_synthetic_media,
      notify_subscribers: parsed.data.notify_subscribers,
      status: "awaiting_confirmation",
      confirmation_token_hash: tokenHash,
      confirmation_expires_at: expiresAt,
      next_attempt_at: new Date(now).toISOString(),
    })
    .select(
      "id, title, description, tags, visibility, made_for_kids, contains_synthetic_media, notify_subscribers, confirmation_expires_at",
    )
    .single();
  if (error || !publication) return apiError("youtube_unavailable", 503);

  return NextResponse.json(
    {
      data: {
        publication: {
          id: publication.id,
          title: publication.title,
          description: publication.description,
          tags: publication.tags,
          visibility: publication.visibility,
          made_for_kids: publication.made_for_kids,
          contains_synthetic_media: publication.contains_synthetic_media,
          notify_subscribers: publication.notify_subscribers,
          channel_title: connection.channel_title,
          confirmation_expires_at: publication.confirmation_expires_at,
        },
        confirmation_token: token,
      },
    },
    { status: 201, headers: { "Cache-Control": "private, no-store" } },
  );
}
