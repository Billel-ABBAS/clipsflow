import { describe, expect, it } from "vitest";
import { resolveStripeSetupPolicy } from "./stripe-script-policy";

describe("resolveStripeSetupPolicy", () => {
  it("autorise un dry-run sans aucune clé", () => {
    expect(
      resolveStripeSetupPolicy({ secretKey: undefined, args: [] }),
    ).toEqual({ apply: false, mode: "test" });
  });

  it("exige une clé test avant toute mutation", () => {
    expect(() =>
      resolveStripeSetupPolicy({ secretKey: undefined, args: ["--apply"] }),
    ).toThrow("stripe_setup:key_missing");
  });

  it.each(["sk_live_abcdef123456", "rk_live_abcdef123456", "bad-key"])(
    "rejette toute clé non test: %s",
    (secretKey) => {
      expect(() => resolveStripeSetupPolicy({ secretKey, args: [] })).toThrow(
        "stripe_setup:test_key_required",
      );
    },
  );

  it("reste en dry-run sans --apply", () => {
    expect(
      resolveStripeSetupPolicy({
        secretKey: "sk_test_abcdef123456",
        args: [],
      }),
    ).toEqual({ apply: false, mode: "test" });
  });

  it("autorise les mutations test uniquement avec --apply", () => {
    expect(
      resolveStripeSetupPolicy({
        secretKey: "sk_test_abcdef123456",
        args: ["--apply"],
      }),
    ).toEqual({ apply: true, mode: "test" });
  });

  it("rejette les arguments inconnus", () => {
    expect(() =>
      resolveStripeSetupPolicy({
        secretKey: "sk_test_abcdef123456",
        args: ["--live"],
      }),
    ).toThrow("stripe_setup:unknown_argument");
  });
});
