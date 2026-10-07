import { describe, expect, it } from "vitest";

import {
  getAuthReturnPathFromPathname,
  getAuthCallbackPath,
  getAuthCallbackRedirectUrl,
  getSafeAuthReturnPath,
} from "@/lib/auth/return-path";

describe("auth return paths", () => {
  it("allows safe workspace destinations and defaults to the dashboard", () => {
    expect(getSafeAuthReturnPath("/dashboard")).toBe("/dashboard");
    expect(getSafeAuthReturnPath("/clips")).toBe("/clips");
    expect(getSafeAuthReturnPath("/clips/new")).toBe("/clips/new");
    expect(getSafeAuthReturnPath("/shorts")).toBe("/shorts");
    expect(getSafeAuthReturnPath(null)).toBe("/dashboard");
    expect(getSafeAuthReturnPath("/unknown")).toBe("/dashboard");
  });

  it("maps only the localized dashboard routes to safe auth destinations", () => {
    expect(getAuthReturnPathFromPathname("/fr/shorts", "fr")).toBe("/shorts");
    expect(getAuthReturnPathFromPathname("/en/shorts", "en")).toBe("/shorts");
    expect(getAuthReturnPathFromPathname("/fr/clips/new", "fr")).toBe(
      "/clips/new",
    );
    expect(getAuthReturnPathFromPathname("/fr/shorts/extra", "fr")).toBe(
      "/dashboard",
    );
    expect(getAuthReturnPathFromPathname(null, "fr")).toBe("/dashboard");
  });

  it.each([
    "https://attacker.example",
    "//attacker.example",
    "/\\attacker.example",
    "/shorts?next=https://attacker.example",
    "/shorts%2f..%2faccount",
  ])("rejects an unrecognized or external destination: %s", (raw) => {
    expect(getSafeAuthReturnPath(raw)).toBe("/dashboard");
  });

  it("preserves a safe destination and locale through the OAuth callback", () => {
    expect(getAuthCallbackPath("/shorts", "fr")).toBe("/fr/shorts");
    expect(getAuthCallbackPath("/clips", "en")).toBe("/en/clips");
    expect(getAuthCallbackPath("/clips/new", "fr")).toBe("/fr/clips/new");
    expect(getAuthCallbackPath("/shorts", "de")).toBe("/en/shorts");
    expect(getAuthCallbackPath("https://attacker.example", "fr")).toBe(
      "/fr/dashboard",
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
