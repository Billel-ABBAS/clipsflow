import {
  isShortsAnalysisConfigurationEligible,
  resolveShortsProviderCapabilities,
  type ShortsProviderCapabilities,
  type ShortsProviderEnvironment,
} from "./provider-capabilities";

/**
 * Resolves visible and submission capabilities from server configuration plus
 * runtime database evidence. The health reader is injected for deterministic
 * tests; production callers must use the server-only wrapper.
 */
export async function resolveShortsProviderCapabilitiesWithHealth(
  environment: ShortsProviderEnvironment,
  readHeartbeat: () => Promise<boolean>,
): Promise<ShortsProviderCapabilities> {
  let analysisWorkerHeartbeatFresh = false;
  if (isShortsAnalysisConfigurationEligible(environment)) {
    try {
      analysisWorkerHeartbeatFresh = await readHeartbeat();
    } catch {
      analysisWorkerHeartbeatFresh = false;
    }
  }

  return resolveShortsProviderCapabilities(environment, {
    analysisWorkerHeartbeatFresh,
  });
}
