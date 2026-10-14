import { describe, expect, it, vi } from "vitest";

import { resolveShortsProviderCapabilitiesWithHealth } from "./provider-capabilities-server-core";
import type { ShortsProviderEnvironment } from "./provider-capabilities";

const readyEnvironment: ShortsProviderEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  SHORTS_ANALYSIS_WORKER_READY: "true",
  OPENAI_API_KEY: "private-test-key",
};

describe("server Shorts provider capabilities", () => {
  it("does not query worker health while rollout or provider configuration is closed", async () => {
    const readHeartbeat = vi.fn().mockResolvedValue(true);

    const capabilities = await resolveShortsProviderCapabilitiesWithHealth(
      { ...readyEnvironment, SHORTS_ANALYSIS_WORKER_READY: "false" },
      readHeartbeat,
    );

    expect(readHeartbeat).not.toHaveBeenCalled();
    expect(capabilities.audioAnalysis).toBe(false);
  });

  it("requires a fresh worker heartbeat in addition to configuration", async () => {
    const stale = await resolveShortsProviderCapabilitiesWithHealth(
      readyEnvironment,
      async () => false,
    );
    expect(stale.audioAnalysis).toBe(false);

    const fresh = await resolveShortsProviderCapabilitiesWithHealth(
      readyEnvironment,
      async () => true,
    );
    expect(fresh.audioAnalysis).toBe(true);
  });

  it("fails closed when heartbeat reads fail", async () => {
    const capabilities = await resolveShortsProviderCapabilitiesWithHealth(
      readyEnvironment,
      async () => {
        throw new Error("Supabase unavailable");
      },
    );

    expect(capabilities.audioAnalysis).toBe(false);
    expect(capabilities.videoAnalysis).toBe(false);
  });
});
