import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import { apiError, isSameOriginMutation } from "@/lib/youtube/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUserAndFeature() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, enabled: false };
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  return { user, enabled: isClipsEnabled({ locale, userId: user.id }) };
}

export async function GET(): Promise<Response> {
  const { user, enabled } = await getUserAndFeature();
  if (!user) return apiError("unauthorized", 401);
  if (!enabled) return apiError("not_yet_available", 403);

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return apiError("youtube_unavailable", 503);
  }
  const { data, error } = await admin
    .from("youtube_connections")
    .select("id, channel_id, channel_title, connected_at, last_used_at")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .is("disconnected_at", null)
    .order("connected_at", { ascending: false })
    .limit(10);
  if (error) return apiError("youtube_unavailable", 503);
  return NextResponse.json(
    {
      data: (data ?? []).map((connection) => ({
        id: connection.id,
        channel_id: connection.channel_id,
        channel_title: connection.channel_title,
        connected_at: connection.connected_at,
        last_used_at: connection.last_used_at,
      })),
      capabilities: {
        non_private_uploads_enabled:
          process.env.YOUTUBE_PUBLIC_UPLOADS_ENABLED === "true",
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError("invalid_origin", 403);
  const { user, enabled } = await getUserAndFeature();
  if (!user) return apiError("unauthorized", 401);
  if (!enabled) return apiError("not_yet_available", 403);
  const body = await request.json().catch(() => null);
  const connectionId =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).connectionId
      : null;
  if (
    typeof connectionId !== "string" ||
    !z.uuid().safeParse(connectionId).success
  ) {
    return apiError("validation_error", 400);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return apiError("youtube_unavailable", 503);
  }
  const { data: connection, error: findError } = await admin
    .from("youtube_connections")
    .select("id, refresh_token_ciphertext")
    .eq("id", connectionId)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .not("refresh_token_ciphertext", "is", null)
    .maybeSingle();
  if (findError) return apiError("youtube_unavailable", 503);
  if (!connection) return apiError("connection_not_found", 404);

  const { data: queued, error: queuedError } = await admin
    .from("shorts_publications")
    .update({
      status: "failed",
      error_code: "connection_disconnected",
      error_message: "connection_disconnected",
      worker_lease_token: null,
      worker_lease_expires_at: null,
      confirmation_token_hash: null,
      confirmation_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .eq("youtube_connection_id", connection.id)
    .in("status", ["awaiting_confirmation", "queued", "uploading"])
    .select("id");
  if (queuedError) return apiError("youtube_unavailable", 503);

  const { error } = await admin
    .from("youtube_connections")
    .update({
      refresh_token_ciphertext: null,
      is_active: false,
      disconnected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id)
    .eq("user_id", user.id)
    .eq("is_active", true);
  if (error) return apiError("youtube_unavailable", 503);

  return NextResponse.json(
    {
      data: { disconnected: true, cancelled_publications: queued?.length ?? 0 },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
