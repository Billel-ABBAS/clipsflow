import { describe, expect, it } from "vitest";

import {
  encodePendingYouTubeOAuth,
  parsePendingYouTubeOAuth,
  YOUTUBE_OAUTH_COOKIE,
  YOUTUBE_OAUTH_COOKIE_PATH,
} from "./oauth-session";

const pending = {
  state: "signed-state.signature",
  codeVerifier: "V".repeat(86),
  userId: "34b6ee36-25bd-4963-8a56-cf5d336ae512",
  issuedAt: 1_700_000_000_000,
  returnPath: "/fr/clips?tab=ready",
} as const;

describe("YouTube OAuth session cookie", () => {
  it("round-trips the short-lived PKCE session payload", () => {
    const encoded = encodePendingYouTubeOAuth(pending);

    expect(parsePendingYouTubeOAuth(encoded)).toEqual(pending);
    expect(YOUTUBE_OAUTH_COOKIE).toBe("clipsflow_youtube_oauth");
    expect(YOUTUBE_OAUTH_COOKIE_PATH).toBe("/api/youtube/oauth");
  });

  it.each([
    undefined,
    "",
    "not base64!",
    Buffer.from("[]", "utf8").toString("base64url"),
    Buffer.from(
      JSON.stringify({ ...pending, codeVerifier: "short" }),
      "utf8",
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({ ...pending, userId: "not-a-uuid" }),
      "utf8",
    ).toString("base64url"),
  ])("rejects a malformed pending OAuth cookie", (value) => {
    expect(parsePendingYouTubeOAuth(value)).toBeNull();
  });

  it("rejects non-canonical or oversized cookie data", () => {
    const encoded = encodePendingYouTubeOAuth(pending);
    expect(parsePendingYouTubeOAuth(`${encoded}=`)).toBeNull();
    expect(parsePendingYouTubeOAuth("A".repeat(8_193))).toBeNull();
  });
});
