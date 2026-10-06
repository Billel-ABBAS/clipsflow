// ClipsFlow — GET /api/auth/google
// Initie le flux OAuth Google via Supabase

import { NextResponse } from "next/server";
import { hasLocale } from "next-intl";

import { routing } from "@/i18n/routing";
import { getAuthCallbackPath } from "@/lib/auth/return-path";
import { createClient } from "@/lib/supabase/server";
import { getTrustedAppUrl } from "@/lib/http/trusted-app-url";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedLocale = searchParams.get("locale");
  const locale = hasLocale(routing.locales, requestedLocale)
    ? requestedLocale
    : routing.defaultLocale;
  let callbackUrl: URL;
  try {
    callbackUrl = new URL("/api/auth/callback", getTrustedAppUrl());
    callbackUrl.searchParams.set(
      "next",
      getAuthCallbackPath(searchParams.get("next"), locale),
    );
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
