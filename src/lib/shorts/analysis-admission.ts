import { z } from "zod";
import type { ShortsProviderCapabilities } from "./provider-capabilities";

/**
 * Optional deployment-wide restriction for a controlled analysis rollout.
 * Undefined preserves normal admission; any explicitly invalid value closes it.
 * This is not a worker-health signal or a limit on the number of jobs.
 */
export function isShortsAnalysisUserAllowed(
  userId: string,
  configuredUserId: string | undefined,
): boolean {
  if (configuredUserId === undefined) return true;
  const allowed = z.uuid().safeParse(configuredUserId.trim());
  const user = z.uuid().safeParse(userId);
  return (
    allowed.success &&
    user.success &&
    allowed.data.toLowerCase() === user.data.toLowerCase()
  );
}

/** Align the Studio's available analysis modes with the same server gate. */
export function filterShortsAnalysisCapabilities(
  capabilities: ShortsProviderCapabilities,
  userId: string,
  configuredUserId: string | undefined,
): ShortsProviderCapabilities {
  if (isShortsAnalysisUserAllowed(userId, configuredUserId))
    return capabilities;
  return { ...capabilities, audioAnalysis: false, videoAnalysis: false };
}
