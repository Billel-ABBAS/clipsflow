import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import { getTrustedAppUrl } from "@/lib/http/trusted-app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const localeSchema = z.enum(["en", "fr"]);
const deleteSchema = z.strictObject({ share_id: z.uuid() });

async function authenticatedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function rateLimit(
  userId: string,
): Promise<"allowed" | "limited" | "unavailable"> {
  try {
    const result = await checkDistributedRateLimit(
      createAdminClient(),
      `share-links:${userId}`,
      20,
      60,
    );
    return result.allowed ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<Response> {
  const user = await authenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { clipId } = await params;
  if (!z.uuid().safeParse(clipId).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: clip } = await admin
    .from("clips")
    .select("id")
    .eq("id", clipId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!clip) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { data, error } = await admin
    .from("clip_share_links")
    .select("id, created_at, revoked_at")
    .eq("clip_id", clipId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: "shares_unavailable" }, { status: 503 });
  }
  return NextResponse.json(
    { data: data ?? [] },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<Response> {
  const user = await authenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { clipId } = await params;
  if (!z.uuid().safeParse(clipId).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsedLocale = z.strictObject({ locale: localeSchema }).safeParse(body);
  if (!parsedLocale.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }
  const limit = await rateLimit(user.id);
  if (limit === "unavailable") {
    return NextResponse.json(
      { error: "rate_limit_unavailable" },
      { status: 503 },
    );
  }
  if (limit === "limited") {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const admin = createAdminClient();
  const { data: clip } = await admin
    .from("clips")
    .select("id, status, video_storage_path")
    .eq("id", clipId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!clip) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (clip.status !== "completed" || !clip.video_storage_path) {
    return NextResponse.json({ error: "clip_not_ready" }, { status: 409 });
  }

  const token = randomBytes(32).toString("base64url");
  const { data: share, error } = await admin
    .from("clip_share_links")
    .insert({
      user_id: user.id,
      clip_id: clipId,
      token_hash: hashToken(token),
    })
    .select("id, created_at")
    .single();
  if (error || !share) {
    return NextResponse.json({ error: "share_create_failed" }, { status: 500 });
  }

  const url = getTrustedAppUrl();
  url.pathname = `/${parsedLocale.data.locale}/share/${token}`;
  return NextResponse.json(
    {
      data: { id: share.id, created_at: share.created_at, url: url.toString() },
    },
    { status: 201, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<Response> {
  const user = await authenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { clipId } = await params;
  if (!z.uuid().safeParse(clipId).success) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_error" }, { status: 400 });
  }

  const { data, error } = await createAdminClient()
    .from("clip_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", parsed.data.share_id)
    .eq("clip_id", clipId)
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "share_revoke_failed" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ data: { id: data.id, revoked: true } });
}
