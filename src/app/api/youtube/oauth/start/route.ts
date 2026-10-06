import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import {
  createYouTubeOAuthAuthorizationRequest,
  getYouTubeOAuthConfig,
  safeYouTubeOAuthReturnPath,
} from "@/lib/youtube/oauth";
import {
  encodePendingYouTubeOAuth,
  YOUTUBE_OAUTH_COOKIE,
  YOUTUBE_OAUTH_COOKIE_PATH,
} from "@/lib/youtube/oauth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFallbackPath(locale: string): string {
  return `/${locale}/clips`;
}

export async function GET(request: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const localeCookie = (await cookies()).get("NEXT_LOCALE")?.value;
  const locale = routing.locales.includes(localeCookie as never)
    ? localeCookie!
    : routing.defaultLocale;
  const fallbackPath = safeFallbackPath(locale);

  const redirectWithError = (error: string): NextResponse => {
    const destination = new URL(fallbackPath, request.url);
    destination.searchParams.set("youtube_error", error);
    return NextResponse.redirect(destination);
  };

  if (!user) return redirectWithError("unauthorized");
  if (!isClipsEnabled({ locale, userId: user.id })) {
    return redirectWithError("not_yet_available");
  }

  try {
    const config = getYouTubeOAuthConfig(process.env, {
      allowHttpLocalhost: process.env.NODE_ENV !== "production",
    });
    const returnPath = safeYouTubeOAuthReturnPath(
      new URL(request.url).searchParams.get("return_path"),
      fallbackPath,
    );
    const oauth = createYouTubeOAuthAuthorizationRequest({
      config,
      returnPath,
    });
    const response = NextResponse.redirect(oauth.authorizationUrl);
    const pending = {
      state: oauth.state,
      codeVerifier: oauth.codeVerifier,
      userId: user.id,
      issuedAt: Date.now(),
      returnPath,
    };
    response.cookies.set(
      YOUTUBE_OAUTH_COOKIE,
      encodePendingYouTubeOAuth(pending),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: YOUTUBE_OAUTH_COOKIE_PATH,
        maxAge: 600,
      },
    );
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return redirectWithError("configuration_unavailable");
  }
}
