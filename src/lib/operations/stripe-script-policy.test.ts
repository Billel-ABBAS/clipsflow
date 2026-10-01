import { describe, expect, it } from "vitest";
import { resolveStripeSetupPolicy } from "./stripe-script-policy";

const syntheticStripeKey = (prefix: string) => `${prefix}${"x".repeat(32)}`;

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

  it.each([
    syntheticStripeKey("sk_live_"),
    syntheticStripeKey("rk_live_"),
    "bad-key",
  ])("rejette toute clé non test: %s", (secretKey) => {
    expect(() => resolveStripeSetupPolicy({ secretKey, args: [] })).toThrow(
      "stripe_setup:test_key_required",
    );
  });

  it("reste en dry-run sans --apply", () => {
    expect(
      resolveStripeSetupPolicy({
        secretKey: syntheticStripeKey("sk_test_"),
        args: [],
      }),
    ).toEqual({ apply: false, mode: "test" });
  });

  it("autorise les mutations test uniquement avec --apply", () => {
    expect(
      resolveStripeSetupPolicy({
        secretKey: syntheticStripeKey("sk_test_"),
        args: ["--apply"],
      }),
    ).toEqual({ apply: true, mode: "test" });
  });

  it("rejette les arguments inconnus", () => {
    expect(() =>
      resolveStripeSetupPolicy({
        secretKey: syntheticStripeKey("sk_test_"),
        args: ["--live"],
      }),
    ).toThrow("stripe_setup:unknown_argument");
  });
});
