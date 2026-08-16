// ClipsFlow — GET /api/auth/google
// Initie le flux OAuth Google via Supabase

import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getTrustedAppUrl } from "@/lib/http/trusted-app-url";

export async function GET() {
  let callbackUrl: URL;
  try {
    callbackUrl = new URL("/api/auth/callback", getTrustedAppUrl());
    callbackUrl.searchParams.set("next", "/clips");
  } catch {
    return NextResponse.json(
      { error: "app_url_not_configured" },
      { status: 503 },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl.href,
    },
  });

  if (error) {
    return NextResponse.json({ error: "oauth_unavailable" }, { status: 500 });
  }

  if (data.url) {
    return NextResponse.redirect(data.url);
  }

  return NextResponse.json({ error: "OAuth not available" }, { status: 500 });
}
