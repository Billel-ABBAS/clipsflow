import { describe, expect, it } from "vitest";

import {
  DEFAULT_YOUTUBE_RETURN_PATH,
  YOUTUBE_REQUESTED_SCOPES,
  buildYouTubeOAuthAuthorizationUrl,
  buildYouTubePublishRequestPayload,
  createPkceCodeChallenge,
  createYouTubeOAuthAuthorizationRequest,
  createYouTubeOAuthState,
  parseYouTubeOAuthConfig,
  safeYouTubeOAuthReturnPath,
  validateYouTubeOAuthCallbackState,
} from "./oauth";

const stateSecret = "state-secret-with-at-least-thirty-two-characters";
const validEnvironment = {
  YOUTUBE_OAUTH_CLIENT_ID: "clipsflow-test.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: "youtube-client-secret",
  YOUTUBE_OAUTH_REDIRECT_URI: "https://clips.example.com/api/youtube/callback",
  YOUTUBE_OAUTH_STATE_SECRET: stateSecret,
};

const config = parseYouTubeOAuthConfig(validEnvironment);
const fixedNonce = "A".repeat(43);
const fixedVerifier = "B".repeat(43);
const fixedIssuedAt = 1_700_000_000_000;

describe("parseYouTubeOAuthConfig", () => {
  it("accepts the required server-only configuration", () => {
    expect(config).toEqual({
      clientId: validEnvironment.YOUTUBE_OAUTH_CLIENT_ID,
      clientSecret: validEnvironment.YOUTUBE_OAUTH_CLIENT_SECRET,
      redirectUri: validEnvironment.YOUTUBE_OAUTH_REDIRECT_URI,
      stateSecret,
    });
  });

  it("fails closed for absent, public, weak, or unsafe configuration", () => {
    expect(() =>
      parseYouTubeOAuthConfig({
        ...validEnvironment,
        YOUTUBE_OAUTH_CLIENT_SECRET: "",
      }),
    ).toThrow("youtube_oauth:config_missing");
    expect(() =>
      parseYouTubeOAuthConfig({
        ...validEnvironment,
        NEXT_PUBLIC_YOUTUBE_OAUTH_STATE_SECRET: stateSecret,
      }),
    ).toThrow("youtube_oauth:public_secret_configured");
    expect(() =>
      parseYouTubeOAuthConfig({
        ...validEnvironment,
        YOUTUBE_OAUTH_STATE_SECRET: "too-short",
      }),
    ).toThrow("youtube_oauth:state_secret_too_short");
    expect(() =>
      parseYouTubeOAuthConfig({
        ...validEnvironment,
        YOUTUBE_OAUTH_REDIRECT_URI: "http://clips.example.com/callback",
      }),
    ).toThrow("youtube_oauth:redirect_uri_invalid");
    expect(() =>
      parseYouTubeOAuthConfig({
        ...validEnvironment,
        YOUTUBE_OAUTH_REDIRECT_URI:
          "https://clips.example.com/callback?next=https://evil.example",
      }),
    ).toThrow("youtube_oauth:redirect_uri_invalid");
  });

  it("allows HTTP only through an explicit localhost-development opt-in", () => {
    expect(() =>
      parseYouTubeOAuthConfig({
        ...validEnvironment,
        YOUTUBE_OAUTH_REDIRECT_URI:
          "http://localhost:3000/api/youtube/callback",
      }),
    ).toThrow("youtube_oauth:redirect_uri_invalid");
    expect(
      parseYouTubeOAuthConfig(
        {
          ...validEnvironment,
          YOUTUBE_OAUTH_REDIRECT_URI:
            "http://localhost:3000/api/youtube/callback",
        },
        { allowHttpLocalhost: true },
      ).redirectUri,
    ).toBe("http://localhost:3000/api/youtube/callback");
  });
});

describe("PKCE and OAuth authorization URL", () => {
  it("implements the RFC 7636 S256 test vector", () => {
    expect(
      createPkceCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("requests bounded upload/read-only scopes with code flow and PKCE", () => {
    const state = createYouTubeOAuthState({
      stateSecret,
      nonce: fixedNonce,
      returnPath: "/fr/clips?tab=ready",
      issuedAt: fixedIssuedAt,
    });
    const url = new URL(
      buildYouTubeOAuthAuthorizationUrl({
        config,
        state,
        codeVerifier: fixedVerifier,
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(
      YOUTUBE_REQUESTED_SCOPES.join(" "),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createPkceCodeChallenge(fixedVerifier),
    );
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("creates usable high-entropy state and verifier values for a server route", () => {
    const request = createYouTubeOAuthAuthorizationRequest({ config });
    expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(request.state).toContain(".");
    expect(request.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("state and return-path validation", () => {
  it("keeps a safe internal return path and validates a matching callback", () => {
    const state = createYouTubeOAuthState({
      stateSecret,
      nonce: fixedNonce,
      returnPath: "/en/clips?filter=ready",
      issuedAt: fixedIssuedAt,
    });

    expect(
      validateYouTubeOAuthCallbackState({
        receivedState: state,
        expectedState: state,
        stateSecret,
        now: fixedIssuedAt + 1_000,
      }),
    ).toEqual({
      nonce: fixedNonce,
      returnPath: "/en/clips?filter=ready",
      issuedAt: fixedIssuedAt,
    });
  });

  it.each([
    "https://evil.example",
    "//evil.example/path",
    "/\\evil.example/path",
    "/clips%2F%2Fevil.example",
    "/clips\r\nLocation:https://evil.example",
  ])("falls back for an unsafe return path: %s", (path) => {
    expect(safeYouTubeOAuthReturnPath(path)).toBe(DEFAULT_YOUTUBE_RETURN_PATH);
  });

  it("signs the fallback instead of an unsafe return path", () => {
    const state = createYouTubeOAuthState({
      stateSecret,
      nonce: fixedNonce,
      returnPath: "https://evil.example",
      issuedAt: fixedIssuedAt,
    });
    expect(
      validateYouTubeOAuthCallbackState({
        receivedState: state,
        expectedState: state,
        stateSecret,
        now: fixedIssuedAt,
      }).returnPath,
    ).toBe(DEFAULT_YOUTUBE_RETURN_PATH);
  });

  it("rejects a mismatched, tampered, or expired callback state", () => {
    const state = createYouTubeOAuthState({
      stateSecret,
      nonce: fixedNonce,
      issuedAt: fixedIssuedAt,
    });
    expect(() =>
      validateYouTubeOAuthCallbackState({
        receivedState: state,
        expectedState: `${state}different`,
        stateSecret,
        now: fixedIssuedAt,
      }),
    ).toThrow("youtube_oauth:state_mismatch");
    expect(() =>
      validateYouTubeOAuthCallbackState({
        receivedState: `${state.slice(0, -1)}x`,
        expectedState: `${state.slice(0, -1)}x`,
        stateSecret,
        now: fixedIssuedAt,
      }),
    ).toThrow("youtube_oauth:state_invalid");
    expect(() =>
      validateYouTubeOAuthCallbackState({
        receivedState: state,
        expectedState: state,
        stateSecret,
        now: fixedIssuedAt + 10 * 60 * 1000 + 1,
      }),
    ).toThrow("youtube_oauth:state_expired");
  });
});

describe("buildYouTubePublishRequestPayload", () => {
  it("defaults uploads to private and suppresses subscriber notifications", () => {
    expect(buildYouTubePublishRequestPayload({ title: "Mon Short" })).toEqual({
      part: ["snippet", "status"],
      notifySubscribers: false,
      body: {
        snippet: { title: "Mon Short", description: "" },
        status: { privacyStatus: "private" },
      },
    });
  });

  it("allows an explicit unlisted upload and preserves explicit metadata", () => {
    expect(
      buildYouTubePublishRequestPayload({
        title: "  Conseil IA  ",
        description: "Une description.",
        tags: ["IA", "shorts", "IA"],
        privacyStatus: "unlisted",
        notifySubscribers: true,
        madeForKids: false,
      }),
    ).toEqual({
      part: ["snippet", "status"],
      notifySubscribers: true,
      body: {
        snippet: {
          title: "Conseil IA",
          description: "Une description.",
          tags: ["IA", "shorts"],
        },
        status: {
          privacyStatus: "unlisted",
          selfDeclaredMadeForKids: false,
        },
      },
    });
  });

  it("never publishes publicly without a separate explicit confirmation", () => {
    expect(() =>
      buildYouTubePublishRequestPayload({
        title: "Short public",
        privacyStatus: "public",
      }),
    ).toThrow("youtube_publish:public_confirmation_required");
    expect(
      buildYouTubePublishRequestPayload({
        title: "Short public",
        privacyStatus: "public",
        confirmPublic: true,
      }).body.status.privacyStatus,
    ).toBe("public");
  });
});
