// ClipsFlow — GET /api/auth/callback
// OAuth callback — récupère la session, redirige vers /clips

import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getTrustedAppUrl, safeRelativePath } from "@/lib/http/trusted-app-url";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeRelativePath(searchParams.get("next"), "/clips");
  let appUrl: URL;
  try {
    appUrl = getTrustedAppUrl();
  } catch {
    return NextResponse.json(
      { error: "app_url_not_configured" },
      { status: 503 },
    );
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Ensure the profile exists (createAdminClient sees the user row)
      const admin = createAdminClient();
      const { data: userRow } = await admin
        .from("profiles")
        .select("id")
        .eq("id", (await supabase.auth.getUser()).data.user?.id ?? "")
        .maybeSingle();

      if (!userRow) {
        return NextResponse.redirect(
          new URL("/login?error=profile_not_found", appUrl),
        );
      }

      return NextResponse.redirect(new URL(next, appUrl));
    }
  }

  return NextResponse.redirect(new URL("/login?error=oauth_error", appUrl));
}
