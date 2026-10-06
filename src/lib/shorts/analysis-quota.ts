import type { Plan } from "@/lib/clips/quota";

export interface ShortsAnalysisQuotaEnvironment {
  SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_FREE?: string;
  SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_SOLO?: string;
  SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_PRO?: string;
  SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_STUDIO?: string;
}

const QUOTA_ENV_BY_PLAN: Record<Plan, keyof ShortsAnalysisQuotaEnvironment> = {
  free: "SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_FREE",
  solo: "SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_SOLO",
  pro: "SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_PRO",
  studio: "SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_STUDIO",
};

/**
 * Resolve a server-owned monthly analysis allowance for a billing plan.
 * Values are source seconds, not rendered-clip seconds. Missing or malformed
 * values fail closed; zero is valid and intentionally disables analysis for
 * that plan. The function never reads public/NEXT_PUBLIC configuration.
 */
export function resolveShortsAnalysisQuotaSeconds(
  plan: Plan,
  environment: ShortsAnalysisQuotaEnvironment = process.env as ShortsAnalysisQuotaEnvironment,
): number | null {
  const raw = environment[QUOTA_ENV_BY_PLAN[plan]]?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return null;

  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}
