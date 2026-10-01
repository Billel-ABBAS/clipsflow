/** Restrict the staging smoke test to the authorized Billel project. */
export const AUTHORIZED_STAGING_PROJECT_REF = "ifwdzqzoqwitahffrvcr";
export const STAGING_RENDER_BUDGET_CAP_USD = 0.01;

/** Accept only an enabled, finite staging budget within the one-cent test cap. */
export function isStagingBudgetGuardReady(
  enabled: unknown,
  monthlyBudgetUsd: unknown,
): boolean {
  const budget = Number(monthlyBudgetUsd);
  return (
    enabled === true &&
    Number.isFinite(budget) &&
    budget > 0 &&
    budget <= STAGING_RENDER_BUDGET_CAP_USD
  );
}

/** Fail before a smoke-test env file is opened unless its project is pinned. */
export function assertAuthorizedStagingRef(
  expectedRef: string | undefined,
): void {
  if (expectedRef !== AUTHORIZED_STAGING_PROJECT_REF) {
    throw new Error(
      "staging_render_smoke:expected_staging_project_ref_required",
    );
  }
}

/**
 * Validate the staging Supabase URL before the smoke test creates any data.
 * Requiring an explicit expected ref makes accidental use of .env.local fail
 * closed instead of silently targeting another Supabase account or production.
 */
export function validateStagingSupabaseUrl(
  rawUrl: string,
  expectedRef: string | undefined,
): string {
  assertAuthorizedStagingRef(expectedRef);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("staging_render_smoke:invalid_supabase_url");
  }

  const expectedOrigin = `https://${AUTHORIZED_STAGING_PROJECT_REF}.supabase.co`;
  if (
    parsed.origin !== expectedOrigin ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("staging_render_smoke:unexpected_supabase_project");
  }

  return expectedOrigin;
}
