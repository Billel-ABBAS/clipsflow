import { describe, expect, it } from "vitest";
import {
  assertProductionTestDataWriteOptIn,
  AUTHORIZED_RENDER_TEST_PROJECT_REF,
  isStagingBudgetGuardReady,
  STAGING_RENDER_BUDGET_CAP_USD,
  validateStagingSupabaseUrl,
} from "./staging-smoke-config";

describe("staging render smoke project guard", () => {
  it("accepts only the explicitly selected Billel production project", () => {
    expect(
      validateStagingSupabaseUrl(
        `https://${AUTHORIZED_RENDER_TEST_PROJECT_REF}.supabase.co/`,
        AUTHORIZED_RENDER_TEST_PROJECT_REF,
      ),
    ).toBe(`https://${AUTHORIZED_RENDER_TEST_PROJECT_REF}.supabase.co`);
  });

  it.each([undefined, "luympnrbthbcgbemxykp", "hkbzphqdplddlvlkbxus"])(
    "rejects an absent or non-staging expected ref (%s)",
    (expectedRef) => {
      expect(() =>
        validateStagingSupabaseUrl(
          `https://${AUTHORIZED_RENDER_TEST_PROJECT_REF}.supabase.co`,
          expectedRef,
        ),
      ).toThrow(
        "staging_render_smoke:expected_authorized_project_ref_required",
      );
    },
  );

  it.each([
    "http://ifwdzqzoqwitahffrvcr.supabase.co",
    "https://luympnrbthbcgbemxykp.supabase.co",
    "https://ifwdzqzoqwitahffrvcr.supabase.co/path",
    "https://user:secret@ifwdzqzoqwitahffrvcr.supabase.co",
    "https://ifwdzqzoqwitahffrvcr.supabase.co?project=other",
  ])("rejects unsafe Supabase URLs without echoing them", (url) => {
    expect(() =>
      validateStagingSupabaseUrl(url, AUTHORIZED_RENDER_TEST_PROJECT_REF),
    ).toThrow("staging_render_smoke:unexpected_supabase_project");
  });
});

describe("production synthetic-data write opt-in", () => {
  it("requires a precise opt-in before creating smoke-test rows", () => {
    expect(() => assertProductionTestDataWriteOptIn(undefined)).toThrow(
      "staging_render_smoke:production_test_data_write_opt_in_required",
    );
    expect(() => assertProductionTestDataWriteOptIn("false")).toThrow(
      "staging_render_smoke:production_test_data_write_opt_in_required",
    );
    expect(() => assertProductionTestDataWriteOptIn("true")).not.toThrow();
  });
});

describe("staging render budget guard", () => {
  it("allows only an enabled budget within the one-cent cap", () => {
    expect(isStagingBudgetGuardReady(true, 0.01)).toBe(true);
    expect(isStagingBudgetGuardReady(true, "0.005")).toBe(true);
    expect(STAGING_RENDER_BUDGET_CAP_USD).toBe(0.01);
  });

  it.each([
    [false, 0.01],
    [true, null],
    [true, 0],
    [true, -0.01],
    [true, 0.0101],
    [true, Number.NaN],
    [true, Number.POSITIVE_INFINITY],
  ])("rejects unsafe staging budget config (%s, %s)", (enabled, budget) => {
    expect(isStagingBudgetGuardReady(enabled, budget)).toBe(false);
  });
});
