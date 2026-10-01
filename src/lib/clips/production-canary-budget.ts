export const MAX_PRODUCTION_CANARY_MONTHLY_BUDGET_USD = 10;

export type ProductionCanaryBudgetInput = {
  guardEnabled: boolean | null | undefined;
  monthlyBudgetUsd: unknown;
  monthlySpendUsd: number;
  estimatedCostUsd: number;
};

export type ProductionCanaryBudgetFailure =
  | "production_budget_guard_must_be_enabled_at_or_below_usd_10"
  | "invalid_monthly_cost_data"
  | "invalid_canary_cost_estimate"
  | "production_budget_headroom_insufficient";

/**
 * Check that the configured production budget is enabled, no higher than the
 * authorized ceiling, and has enough remaining headroom for one canary.
 */
export function getProductionCanaryBudgetFailure(
  input: ProductionCanaryBudgetInput,
): ProductionCanaryBudgetFailure | null {
  const monthlyBudgetUsd = Number(input.monthlyBudgetUsd);

  if (
    !input.guardEnabled ||
    !Number.isFinite(monthlyBudgetUsd) ||
    monthlyBudgetUsd <= 0 ||
    monthlyBudgetUsd > MAX_PRODUCTION_CANARY_MONTHLY_BUDGET_USD
  ) {
    return "production_budget_guard_must_be_enabled_at_or_below_usd_10";
  }

  if (!Number.isFinite(input.monthlySpendUsd) || input.monthlySpendUsd < 0) {
    return "invalid_monthly_cost_data";
  }

  if (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0) {
    return "invalid_canary_cost_estimate";
  }

  if (input.monthlySpendUsd + input.estimatedCostUsd > monthlyBudgetUsd) {
    return "production_budget_headroom_insufficient";
  }

  return null;
}
