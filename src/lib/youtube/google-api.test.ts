import { describe, expect, it, vi } from "vitest";

import {
  YOUTUBE_CHANNELS_LIST_URL,
  YOUTUBE_UPLOAD_SESSION_URL,
  checkYouTubeUploadSession,
  createYouTubeUploadSession,
  exchangeYouTubeAuthorizationCode,
  getAuthorizedYouTubeChannel,
  isValidYouTubeUploadSessionUri,
  refreshYouTubeAccessToken,
  uploadYouTubeChunk,
} from "./google-api";
import { YOUTUBE_REQUESTED_SCOPES } from "./oauth";

const sessionUri =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=opaque-session-id";
const validTokens = {
  access_token: "test-access-token-12345",
  expires_in: 3600,
  refresh_token: "test-refresh-token-12345",
  scope: YOUTUBE_REQUESTED_SCOPES.join(" "),
};

describe("YouTube Google API helpers", () => {
  it("exchanges OAuth codes only with PKCE and requires all requested scopes", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("content-type")).toContain(
          "application/x-www-form-urlencoded",
        );
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code_verifier")).toBe("x".repeat(43));
        return Response.json(validTokens);
      },
    );

    await expect(
      exchangeYouTubeAuthorizationCode({
        clientId: "client-id",
        clientSecret: "secret",
        redirectUri: "https://clips.example.com/api/youtube/oauth/callback",
        code: "authorization-code",
        codeVerifier: "x".repeat(43),
        fetch,
      }),
    ).resolves.toMatchObject({
      accessToken: validTokens.access_token,
      refreshToken: validTokens.refresh_token,
      scopes: YOUTUBE_REQUESTED_SCOPES,
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(
      exchangeYouTubeAuthorizationCode({
        clientId: "client-id",
        clientSecret: "secret",
        redirectUri: "https://clips.example.com/api/youtube/oauth/callback",
        code: "authorization-code",
        codeVerifier: "x".repeat(43),
        fetch: async () =>
          Response.json({ ...validTokens, scope: YOUTUBE_REQUESTED_SCOPES[0] }),
      }),
    ).rejects.toThrow("youtube_provider:oauth_scope_missing");
  });

  it("refreshes access tokens without requiring a rotated refresh token", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        access_token: "refreshed-access-token",
        expires_in: 3600,
      }),
    );
    await expect(
      refreshYouTubeAccessToken({
        clientId: "client-id",
        clientSecret: "secret",
        refreshToken: "stored-refresh-token",
        fetch,
      }),
    ).resolves.toEqual({
      accessToken: "refreshed-access-token",
      expiresIn: 3600,
    });
  });

  it("looks up exactly one authorized channel and rejects ambiguity", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe(YOUTUBE_CHANNELS_LIST_URL);
      return Response.json({
        items: [{ id: "UC_aBc123", snippet: { title: "Creator channel" } }],
      });
    });
    await expect(
      getAuthorizedYouTubeChannel({ accessToken: "access-token", fetch }),
    ).resolves.toEqual({ id: "UC_aBc123", title: "Creator channel" });

    await expect(
      getAuthorizedYouTubeChannel({
        accessToken: "access-token",
        fetch: async () =>
          Response.json({
            items: [
              { id: "UC_aBc123", snippet: { title: "One" } },
              { id: "UC_def456", snippet: { title: "Two" } },
            ],
          }),
      }),
    ).rejects.toThrow("youtube_provider:channel_ambiguous");
  });

  it("creates only a verified resumable upload URL", async () => {
    expect(isValidYouTubeUploadSessionUri(sessionUri)).toBe(true);
    expect(
      isValidYouTubeUploadSessionUri(
        "https://attacker.example/upload/youtube/v3/videos?uploadType=resumable&upload_id=x",
      ),
    ).toBe(false);
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = new URL(String(input));
        expect(requestUrl.origin + requestUrl.pathname).toBe(
          new URL(YOUTUBE_UPLOAD_SESSION_URL).origin +
            new URL(YOUTUBE_UPLOAD_SESSION_URL).pathname,
        );
        expect(requestUrl.searchParams.get("notifySubscribers")).toBe("false");
        expect(new Headers(init?.headers).get("x-upload-content-length")).toBe(
          "1000",
        );
        return new Response(null, {
          status: 200,
          headers: { Location: sessionUri },
        });
      },
    );
    await expect(
      createYouTubeUploadSession({
        accessToken: "access-token",
        notifySubscribers: false,
        contentLength: 1000,
        payload: {
          snippet: { title: "Short", description: "" },
          status: { privacyStatus: "private" },
        },
        fetch,
      }),
    ).resolves.toBe(sessionUri);
  });

  it("reconciles remote offset and parses completion", async () => {
    await expect(
      checkYouTubeUploadSession({
        accessToken: "access-token",
        sessionUri,
        contentLength: 1000,
        fetch: async (_input, init) => {
          expect(new Headers(init?.headers).get("content-range")).toBe(
            "bytes */1000",
          );
          return new Response(null, {
            status: 308,
            headers: { Range: "bytes=0-499" },
          });
        },
      }),
    ).resolves.toEqual({ kind: "incomplete", nextOffset: 500 });

    await expect(
      uploadYouTubeChunk({
        accessToken: "access-token",
        sessionUri,
        contentLength: 1000,
        startOffset: 500,
        bytes: Buffer.alloc(500),
        fetch: async (_input, init) => {
          expect(new Headers(init?.headers).get("content-range")).toBe(
            "bytes 500-999/1000",
          );
          return Response.json({ id: "video_123" }, { status: 201 });
        },
      }),
    ).resolves.toEqual({ kind: "complete", videoId: "video_123" });
  });
});
