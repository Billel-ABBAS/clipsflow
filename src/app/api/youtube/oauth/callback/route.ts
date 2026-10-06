import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { routing } from "@/i18n/routing";
import {
  exchangeYouTubeAuthorizationCode,
  getAuthorizedYouTubeChannel,
  YouTubeProviderError,
} from "@/lib/youtube/google-api";
import {
  getYouTubeOAuthConfig,
  safeYouTubeOAuthReturnPath,
  validateYouTubeOAuthCallbackState,
} from "@/lib/youtube/oauth";
import {
  encryptYouTubeRefreshToken,
  getYouTubeTokenVaultKeyFromEnvironment,
} from "@/lib/youtube/token-vault";
import {
  parsePendingYouTubeOAuth,
  YOUTUBE_OAUTH_COOKIE,
  YOUTUBE_OAUTH_COOKIE_PATH,
} from "@/lib/youtube/oauth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectToPath(
  request: Request,
  returnPath: string,
  status: string,
): NextResponse {
  const path = safeYouTubeOAuthReturnPath(returnPath);
  const destination = new URL(path, request.url);
  destination.searchParams.set(
    status === "connected" ? "youtube" : "youtube_error",
    status,
  );
  const response = NextResponse.redirect(destination);
  response.cookies.set(YOUTUBE_OAUTH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: YOUTUBE_OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function fallbackPath(): string {
  return `/${routing.defaultLocale}/clips`;
}

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const cookieStore = await cookies();
  const pending = parsePendingYouTubeOAuth(
    cookieStore.get(YOUTUBE_OAUTH_COOKIE)?.value,
  );
  let returnPath = fallbackPath();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  try {
    const config = getYouTubeOAuthConfig(process.env, {
      allowHttpLocalhost: process.env.NODE_ENV !== "production",
    });
    const receivedState = query.get("state");
    const code = query.get("code");
    if (!pending || !receivedState) {
      return redirectToPath(request, returnPath, "session_expired");
    }
    const state = validateYouTubeOAuthCallbackState({
      receivedState,
      expectedState: pending.state,
      stateSecret: config.stateSecret,
      now: Date.now(),
    });
    returnPath = state.returnPath;
    if (
      state.returnPath !== pending.returnPath ||
      Date.now() - pending.issuedAt > 10 * 60 * 1_000
    ) {
      return redirectToPath(request, fallbackPath(), "session_expired");
    }
    if (query.has("error"))
      return redirectToPath(request, returnPath, "cancelled");
    if (!user || pending.userId !== user.id || !code) {
      return redirectToPath(request, returnPath, "session_expired");
    }
    const locale = state.returnPath.split("/")[1] ?? routing.defaultLocale;
    if (!isClipsEnabled({ locale, userId: user.id })) {
      return redirectToPath(request, returnPath, "not_yet_available");
    }

    const tokens = await exchangeYouTubeAuthorizationCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      code,
      codeVerifier: pending.codeVerifier,
    });
    const channel = await getAuthorizedYouTubeChannel({
      accessToken: tokens.accessToken,
    });
    const admin = createAdminClient();
    const { data: existing, error: existingError } = await admin
      .from("youtube_connections")
      .select("id, refresh_token_ciphertext")
      .eq("user_id", user.id)
      .eq("provider", "youtube")
      .eq("channel_id", channel.id)
      .maybeSingle();
    if (existingError)
      return redirectToPath(request, returnPath, "storage_unavailable");

    const connectionId = existing?.id ?? randomUUID();
    const refreshToken = tokens.refreshToken;
    let encryptedToken: string | null = null;
    if (refreshToken) {
      const key = getYouTubeTokenVaultKeyFromEnvironment();
      encryptedToken = encryptYouTubeRefreshToken({
        refreshToken,
        context: { userId: user.id, connectionId },
        key,
      });
    } else if (typeof existing?.refresh_token_ciphertext === "string") {
      // Google may omit a replacement refresh token when one already exists.
      encryptedToken = existing.refresh_token_ciphertext;
    }
    if (!encryptedToken) {
      return redirectToPath(request, returnPath, "refresh_token_unavailable");
    }

    const { error: saveError } = await admin.from("youtube_connections").upsert(
      {
        id: connectionId,
        user_id: user.id,
        provider: "youtube",
        channel_id: channel.id,
        channel_title: channel.title,
        refresh_token_ciphertext: encryptedToken,
        encryption_key_version: "v1",
        scopes: tokens.scopes,
        is_active: true,
        disconnected_at: null,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider,channel_id" },
    );
    if (saveError)
      return redirectToPath(request, returnPath, "storage_unavailable");
    return redirectToPath(request, returnPath, "connected");
  } catch (error) {
    const status =
      error instanceof YouTubeProviderError
        ? error.code
        : "connection_unavailable";
    return redirectToPath(request, returnPath, status);
  }
}
