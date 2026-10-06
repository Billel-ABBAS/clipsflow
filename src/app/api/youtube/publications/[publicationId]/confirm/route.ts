import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import { apiError, isSameOriginMutation } from "@/lib/youtube/route-utils";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ publicationId: string }> };
const confirmationSchema = z.strictObject({
  confirmation_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  user_confirmed: z.literal(true),
  confirm_public: z.boolean(),
});

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError("invalid_origin", 403);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return apiError("unauthorized", 401);
  const locale =
    (await cookies()).get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (!isClipsEnabled({ locale, userId: user.id })) {
    return apiError("not_yet_available", 403);
  }
  const { publicationId } = await params;
  if (!z.uuid().safeParse(publicationId).success) {
    return apiError("not_found", 404);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", 400);
  }
  const parsed = confirmationSchema.safeParse(body);
  if (!parsed.success) return apiError("confirmation_required", 400);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return apiError("youtube_unavailable", 503);
  }
  const rateLimit = await checkDistributedRateLimit(
    admin,
    `youtube-publication-confirm:${user.id}`,
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

  const tokenHash = createHash("sha256")
    .update(parsed.data.confirmation_token, "utf8")
    .digest("hex");
  const { data: draft, error: draftError } = await admin
    .from("shorts_publications")
    .select("id, visibility, confirmation_expires_at")
    .eq("id", publicationId)
    .eq("user_id", user.id)
    .eq("status", "awaiting_confirmation")
    .eq("confirmation_token_hash", tokenHash)
    .gt("confirmation_expires_at", new Date().toISOString())
    .maybeSingle();
  if (draftError) return apiError("youtube_unavailable", 503);
  if (!draft) return apiError("confirmation_expired_or_used", 409);
  if (draft.visibility === "public" && parsed.data.confirm_public !== true) {
    return apiError("public_confirmation_required", 400);
  }

  const now = new Date().toISOString();
  const { data: queued, error } = await admin
    .from("shorts_publications")
    .update({
      status: "queued",
      confirmed_at: now,
      confirmation_token_hash: null,
      confirmation_expires_at: null,
      next_attempt_at: now,
      updated_at: now,
      error_code: null,
      error_message: null,
    })
    .eq("id", publicationId)
    .eq("user_id", user.id)
    .eq("status", "awaiting_confirmation")
    .eq("confirmation_token_hash", tokenHash)
    .gt("confirmation_expires_at", now)
    .select("id, status, visibility")
    .maybeSingle();
  if (error) return apiError("youtube_unavailable", 503);
  if (!queued) return apiError("confirmation_expired_or_used", 409);

  return NextResponse.json(
    { data: queued },
    { status: 202, headers: { "Cache-Control": "private, no-store" } },
  );
}
