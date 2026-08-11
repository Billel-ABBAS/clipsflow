// ClipsFlow — GET /api/auth/callback
// OAuth callback — récupère la session, redirige vers /clips

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/clips";

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
        return NextResponse.redirect(`${origin}/login?error=profile_not_found`);
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth_error`);
}
