import { describe, expect, it } from "vitest";

import { resolveYouTubeOAuthFeedback } from "./oauth-feedback";

describe("resolveYouTubeOAuthFeedback", () => {
  it("recognizes a successful OAuth return", () => {
    expect(resolveYouTubeOAuthFeedback({ youtube: "connected" })).toBe(
      "connected",
    );
  });

  it("shows cancellation without exposing arbitrary provider text", () => {
    expect(resolveYouTubeOAuthFeedback({ youtube_error: "cancelled" })).toBe(
      "cancelled",
    );
    expect(
      resolveYouTubeOAuthFeedback({ youtube_error: "storage_unavailable" }),
    ).toBe("error");
  });

  it("treats an error as authoritative if conflicting query values exist", () => {
    expect(
      resolveYouTubeOAuthFeedback({
        youtube: "connected",
        youtube_error: "refresh_token_unavailable",
      }),
    ).toBe("error");
  });

  it("accepts repeated query values safely and ignores unknown success values", () => {
    expect(resolveYouTubeOAuthFeedback({ youtube: ["", "connected"] })).toBe(
      "connected",
    );
    expect(resolveYouTubeOAuthFeedback({ youtube: "published" })).toBeNull();
    expect(resolveYouTubeOAuthFeedback({})).toBeNull();
  });
});
