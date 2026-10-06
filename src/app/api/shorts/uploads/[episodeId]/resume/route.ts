// ============================================================================
// ClipsFlow Shorts — reissue an owner-scoped token for a pending TUS upload
// ============================================================================

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import {
  getShortsTusEndpoint,
  resolveShortsSourceMaxBytes,
  SHORTS_SOURCE_BUCKET,
} from "@/lib/shorts/source-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ episodeId: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function isShortsEnabledForCurrentUser(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  return isClipsEnabled({ locale, userId });
}

export async function POST(
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
  if (!(await isShortsEnabledForCurrentUser(user.id))) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }

  const { episodeId } = await params;
  if (!z.uuid().safeParse(episodeId).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const endpoint = getShortsTusEndpoint(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  );
  if (!endpoint) {
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503 });
  }

  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `shorts-source-upload-resume:${user.id}`,
      20,
      600,
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

  const { data: episode, error: episodeError } = await admin
    .from("episodes")
    .select("id,user_id,source_type,source_storage_path,status")
    .eq("id", episodeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (episodeError) {
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503 });
  }
  if (
    !episode ||
    episode.source_type !== "upload" ||
    typeof episode.source_storage_path !== "string" ||
    !episode.source_storage_path.startsWith(`${user.id}/`)
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (episode.status === "ready") {
    return NextResponse.json(
      { data: { episode_id: episode.id, status: "ready" } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  if (episode.status !== "pending") {
    return NextResponse.json({ error: "upload_not_pending" }, { status: 409 });
  }

  const [ownerFolder, fileName, ...extraParts] =
    episode.source_storage_path.split("/");
  if (ownerFolder !== user.id || !fileName || extraParts.length > 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { data: objects, error: listError } = await admin.storage
    .from(SHORTS_SOURCE_BUCKET)
    .list(user.id, { limit: 1_000, search: fileName });
  if (listError) {
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503 });
  }
  const object = objects?.find((item) => item.name === fileName);
  if (object) {
    const metadata = isRecord(object.metadata) ? object.metadata : null;
    const actualSize = metadata ? Number(metadata.size) : Number.NaN;
    if (
      !Number.isSafeInteger(actualSize) ||
      actualSize < 1 ||
      actualSize >
        resolveShortsSourceMaxBytes(process.env.SHORTS_MAX_SOURCE_BYTES)
    ) {
      return NextResponse.json(
        { error: "upload_not_complete" },
        { status: 409 },
      );
    }

    const { data: updatedEpisode, error: updateError } = await admin
      .from("episodes")
      .update({ status: "ready" })
      .eq("id", episodeId)
      .eq("user_id", user.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (updateError || !updatedEpisode) {
      return NextResponse.json(
        { error: "upload_unavailable" },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { data: { episode_id: episode.id, status: "ready" } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const { data: signedUpload, error: signedUploadError } = await admin.storage
    .from(SHORTS_SOURCE_BUCKET)
    .createSignedUploadUrl(episode.source_storage_path);
  if (signedUploadError || !signedUpload?.token) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-shorts-upload-resume",
        message: "signed resumable upload token unavailable",
      }),
    );
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503 });
  }

  return NextResponse.json(
    {
      data: {
        episode_id: episode.id,
        status: "pending",
        upload_token: signedUpload.token,
        storage_path: episode.source_storage_path,
        endpoint,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
