import { describe, expect, it } from "vitest";

import {
  getPasswordRecoveryRedirectUrl,
  validateRecoveryPassword,
} from "@/lib/auth/password-recovery";

describe("password recovery helpers", () => {
  it.each(["en", "fr"])("creates a same-origin callback for %s", (locale) => {
    const url = new URL(
      getPasswordRecoveryRedirectUrl(
        "https://clipsflow.example/base-path",
        locale,
      ),
    );

    expect(url.origin).toBe("https://clipsflow.example");
    expect(url.pathname).toBe("/api/auth/callback");
    expect(url.searchParams.get("next")).toBe(`/${locale}/reset-password`);
  });

  it("rejects locales outside the supported application languages", () => {
    expect(() =>
      getPasswordRecoveryRedirectUrl("https://clipsflow.example", "de"),
    ).toThrow("unsupported_recovery_locale");
  });

  it("requires matching passwords with at least eight characters", () => {
    expect(validateRecoveryPassword("short", "short")).toBe("too_short");
    expect(validateRecoveryPassword("long-enough", "different")).toBe(
      "mismatch",
    );
    expect(validateRecoveryPassword("long-enough", "long-enough")).toBe(null);
  });
});
