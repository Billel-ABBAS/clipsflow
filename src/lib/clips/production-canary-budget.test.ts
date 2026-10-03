import { describe, expect, it } from "vitest";
import { computeClipCost } from "./cost";
import { getProductionCanaryBudgetFailure } from "./production-canary-budget";

const canaryCost = computeClipCost(12);

describe("getProductionCanaryBudgetFailure", () => {
  it("allows the current one-cent guard when one canary fits under it", () => {
    expect(
      getProductionCanaryBudgetFailure({
        guardEnabled: true,
        monthlyBudgetUsd: "0.0100",
        monthlySpendUsd: 0,
        estimatedCostUsd: canaryCost,
      }),
    ).toBeNull();
  });

  it("allows a budget at the authorized ten-dollar ceiling", () => {
    expect(
      getProductionCanaryBudgetFailure({
        guardEnabled: true,
        monthlyBudgetUsd: 10,
        monthlySpendUsd: 0,
        estimatedCostUsd: canaryCost,
      }),
    ).toBeNull();
  });

  it.each([
    { label: "disabled", enabled: false, budget: 10 },
    { label: "missing", enabled: true, budget: null },
    { label: "zero", enabled: true, budget: 0 },
    { label: "above ceiling", enabled: true, budget: 10.0001 },
    { label: "not numeric", enabled: true, budget: Number.NaN },
  ])("rejects an invalid budget guard ($label)", ({ enabled, budget }) => {
    expect(
      getProductionCanaryBudgetFailure({
        guardEnabled: enabled,
        monthlyBudgetUsd: budget,
        monthlySpendUsd: 0,
        estimatedCostUsd: canaryCost,
      }),
    ).toBe("production_budget_guard_must_be_enabled_at_or_below_usd_10");
  });

  it("rejects a monthly spend that leaves insufficient canary headroom", () => {
    expect(
      getProductionCanaryBudgetFailure({
        guardEnabled: true,
        monthlyBudgetUsd: 0.01,
        monthlySpendUsd: 0.01 - canaryCost / 2,
        estimatedCostUsd: canaryCost,
      }),
    ).toBe("production_budget_headroom_insufficient");
  });

  it("rejects invalid spend and cost values", () => {
    expect(
      getProductionCanaryBudgetFailure({
        guardEnabled: true,
        monthlyBudgetUsd: 0.01,
        monthlySpendUsd: Number.NaN,
        estimatedCostUsd: canaryCost,
      }),
    ).toBe("invalid_monthly_cost_data");

    expect(
      getProductionCanaryBudgetFailure({
        guardEnabled: true,
        monthlyBudgetUsd: 0.01,
        monthlySpendUsd: 0,
        estimatedCostUsd: Number.NaN,
      }),
    ).toBe("invalid_canary_cost_estimate");
  });
});
