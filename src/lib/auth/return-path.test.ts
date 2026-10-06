import { describe, expect, it } from "vitest";

import {
  getAuthReturnPathFromPathname,
  getAuthCallbackPath,
  getAuthCallbackRedirectUrl,
  getSafeAuthReturnPath,
} from "@/lib/auth/return-path";

describe("auth return paths", () => {
  it("allows the Shorts Studio destination and keeps the legacy default", () => {
    expect(getSafeAuthReturnPath("/shorts")).toBe("/shorts");
    expect(getSafeAuthReturnPath(null)).toBe("/clips");
    expect(getSafeAuthReturnPath("/unknown")).toBe("/clips");
  });

  it("maps only the localized dashboard routes to safe auth destinations", () => {
    expect(getAuthReturnPathFromPathname("/fr/shorts", "fr")).toBe("/shorts");
    expect(getAuthReturnPathFromPathname("/en/shorts", "en")).toBe("/shorts");
    expect(getAuthReturnPathFromPathname("/fr/clips/new", "fr")).toBe("/clips");
    expect(getAuthReturnPathFromPathname("/fr/shorts/extra", "fr")).toBe(
      "/clips",
    );
    expect(getAuthReturnPathFromPathname(null, "fr")).toBe("/clips");
  });

  it.each([
    "https://attacker.example",
    "//attacker.example",
    "/\\attacker.example",
    "/shorts?next=https://attacker.example",
    "/shorts%2f..%2faccount",
  ])("rejects an unrecognized or external destination: %s", (raw) => {
    expect(getSafeAuthReturnPath(raw)).toBe("/clips");
  });

  it("preserves a safe destination and locale through the OAuth callback", () => {
    expect(getAuthCallbackPath("/shorts", "fr")).toBe("/fr/shorts");
    expect(getAuthCallbackPath("/clips", "en")).toBe("/en/clips");
    expect(getAuthCallbackPath("/shorts", "de")).toBe("/en/shorts");
    expect(getAuthCallbackPath("https://attacker.example", "fr")).toBe(
      "/fr/clips",
    );
  });

  it("builds a same-origin email confirmation callback with the Shorts return path", () => {
    const callbackUrl = new URL(
      getAuthCallbackRedirectUrl("https://clipsflow.example", "/shorts", "fr"),
    );

    expect(callbackUrl.origin).toBe("https://clipsflow.example");
    expect(callbackUrl.pathname).toBe("/api/auth/callback");
    expect(callbackUrl.searchParams.get("next")).toBe("/fr/shorts");
  });
});
