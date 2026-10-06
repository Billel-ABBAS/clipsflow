import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import { apiError } from "@/lib/youtube/route-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicationId: string }> };

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
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
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return apiError("youtube_unavailable", 503);
  }
  const { data, error } = await admin
    .from("shorts_publications")
    .select(
      "id, status, title, visibility, youtube_url, error_code, created_at, updated_at, published_at",
    )
    .eq("id", publicationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return apiError("youtube_unavailable", 503);
  if (!data) return apiError("not_found", 404);
  return NextResponse.json(
    { data },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
