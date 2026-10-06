// ============================================================================
// ClipsFlow Shorts — create an owner-scoped resumable source upload
// ============================================================================

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import {
  getShortsTusEndpoint,
  resolveShortsSourceMaxBytes,
  SHORTS_SOURCE_BUCKET,
  shortsSourceUploadInitSchema,
} from "@/lib/shorts/source-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import { sanitizeFilename } from "@/lib/utils/storage-path";

export const runtime = "nodejs";
export const maxDuration = 30;

async function isShortsEnabledForCurrentUser(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  return isClipsEnabled({ locale, userId });
}

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = shortsSourceUploadInitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }
  const maxBytes = resolveShortsSourceMaxBytes(
    process.env.SHORTS_MAX_SOURCE_BYTES,
  );
  if (parsed.data.size_bytes > maxBytes) {
    return NextResponse.json(
      { error: "source_too_large", max_bytes: maxBytes },
      { status: 413 },
    );
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
      `shorts-source-upload:${user.id}`,
      8,
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

  const path = `${user.id}/${randomUUID()}-${sanitizeFilename(parsed.data.file_name)}`;
  const { data: signedUpload, error: signedUploadError } = await admin.storage
    .from(SHORTS_SOURCE_BUCKET)
    .createSignedUploadUrl(path);
  if (signedUploadError || !signedUpload?.token) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-shorts-upload-init",
        message: "signed resumable upload token unavailable",
      }),
    );
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503 });
  }

  const { data: episode, error: episodeError } = await admin
    .from("episodes")
    .insert({
      user_id: user.id,
      title: parsed.data.title,
      source_type: "upload",
      source_url: null,
      source_storage_path: path,
      status: "pending",
    })
    .select("id")
    .single();
  if (episodeError || !episode) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-shorts-upload-init",
        message: "pending source record unavailable",
      }),
    );
    return NextResponse.json({ error: "upload_unavailable" }, { status: 503 });
  }

  return NextResponse.json(
    {
      data: {
        episode_id: episode.id,
        upload_token: signedUpload.token,
        storage_path: path,
        endpoint,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
