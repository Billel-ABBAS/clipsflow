import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ShortsProviderCapabilities,
  ShortsProviderEnvironment,
} from "./provider-capabilities";
import { isShortsAnalysisWorkerHeartbeatFresh } from "./analysis-worker-health";
import { resolveShortsProviderCapabilitiesWithHealth } from "./provider-capabilities-server-core";

async function readCurrentWorkerHeartbeat(): Promise<boolean> {
  try {
    return await isShortsAnalysisWorkerHeartbeatFresh(createAdminClient());
  } catch {
    return false;
  }
}

/**
 * Resolves user-visible and submission capabilities from server config plus
 * fresh runtime evidence. An operator flag alone never opens analysis.
 */
export async function resolveShortsProviderCapabilitiesForServer(
  environment: ShortsProviderEnvironment = process.env,
): Promise<ShortsProviderCapabilities> {
  return resolveShortsProviderCapabilitiesWithHealth(
    environment,
    readCurrentWorkerHeartbeat,
  );
}
