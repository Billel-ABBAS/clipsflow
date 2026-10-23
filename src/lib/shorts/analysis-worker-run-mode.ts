export type ShortsAnalysisWorkerRunMode =
  | "disabled"
  | "verify-only"
  | "process-one";

export interface ShortsAnalysisWorkerRunModeEnvironment {
  SHORTS_ANALYSIS_WORKER_ENABLED?: string;
  SHORTS_ANALYSIS_WORKER_VERIFY_ONLY?: string;
}

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/**
 * `verify-only` is deliberately evaluated first. It is the safe post-secret-
 * rotation mode: it may call the protected health RPC, but it must never poll
 * or claim a queue job, even if a stale worker enablement flag is still set.
 */
export function resolveShortsAnalysisWorkerRunMode(
  environment: ShortsAnalysisWorkerRunModeEnvironment,
): ShortsAnalysisWorkerRunMode {
  if (isExplicitlyEnabled(environment.SHORTS_ANALYSIS_WORKER_VERIFY_ONLY)) {
    return "verify-only";
  }

  return isExplicitlyEnabled(environment.SHORTS_ANALYSIS_WORKER_ENABLED)
    ? "process-one"
    : "disabled";
}
