import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import { SHORTS_SOURCE_BUCKET } from "@/lib/shorts/source-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";

export const runtime = "nodejs";
export const maxDuration = 30;

const SIGNED_SOURCE_URL_TTL_SECONDS = 60 * 60;
const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

type RouteContext = { params: Promise<{ episodeId: string }> };

async function isShortsEnabledForCurrentUser(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  return isClipsEnabled({ locale, userId });
}

function privateError(error: string, status: number): NextResponse {
  return NextResponse.json(
    { error },
    { status, headers: PRIVATE_NO_STORE_HEADERS },
  );
}

/**
 * Issues a short-lived playback URL only for a ready source owned by the
 * authenticated creator. Storage paths and provider URLs never come from the
 * browser, and the signed URL is never cached.
 */
export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return privateError("unauthorized", 401);

  const { episodeId } = await params;
  if (!z.uuid().safeParse(episodeId).success) {
    return privateError("not_found", 404);
  }
  if (!(await isShortsEnabledForCurrentUser(user.id))) {
    return privateError("not_yet_available", 403);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return privateError("source_preview_unavailable", 503);
  }

  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `shorts-source-preview:${user.id}`,
      60,
      60,
    );
  } catch {
    return privateError("rate_limit_unavailable", 503);
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          ...PRIVATE_NO_STORE_HEADERS,
          "Retry-After": rateLimit.retryAfterSeconds.toString(),
        },
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
    return privateError("source_preview_unavailable", 503);
  }

  const storagePath = episode?.source_storage_path;
  if (
    !episode ||
    episode.user_id !== user.id ||
    episode.source_type !== "upload" ||
    episode.status !== "ready" ||
    typeof storagePath !== "string"
  ) {
    return privateError("not_found", 404);
  }

  const [ownerFolder, fileName, ...unexpectedParts] = storagePath.split("/");
  if (
    ownerFolder !== user.id ||
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("\\") ||
    unexpectedParts.length > 0
  ) {
    return privateError("not_found", 404);
  }

  const { data: signedSource, error: signError } = await admin.storage
    .from(SHORTS_SOURCE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_SOURCE_URL_TTL_SECONDS);
  if (signError || !signedSource?.signedUrl) {
    return privateError("source_preview_unavailable", 503);
  }

  return NextResponse.json(
    { data: { url: signedSource.signedUrl } },
    { headers: PRIVATE_NO_STORE_HEADERS },
  );
}
