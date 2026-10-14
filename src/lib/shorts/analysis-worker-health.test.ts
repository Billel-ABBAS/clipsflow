import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isShortsAnalysisWorkerHeartbeatFresh,
  recordShortsAnalysisWorkerHeartbeat,
} from "./analysis-worker-health";

function healthClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as Pick<SupabaseClient, "rpc">;
}

describe("Shorts analysis worker heartbeat RPC adapter", () => {
  it("accepts only an explicit healthy boolean", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await expect(
      isShortsAnalysisWorkerHeartbeatFresh(healthClient(rpc)),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("shorts_is_analysis_worker_healthy");

    for (const result of [
      { data: false, error: null },
      { data: null, error: null },
      { data: true, error: new Error("rpc unavailable") },
    ]) {
      await expect(
        isShortsAnalysisWorkerHeartbeatFresh(
          healthClient(vi.fn().mockResolvedValue(result)),
        ),
      ).resolves.toBe(false);
    }
  });

  it("fails closed when the transport throws", async () => {
    await expect(
      isShortsAnalysisWorkerHeartbeatFresh(
        healthClient(vi.fn().mockRejectedValue(new Error("offline"))),
      ),
    ).resolves.toBe(false);
  });

  it("records a heartbeat only when the protected RPC confirms success", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await expect(
      recordShortsAnalysisWorkerHeartbeat(healthClient(rpc)),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("shorts_record_analysis_worker_heartbeat");
    await expect(
      recordShortsAnalysisWorkerHeartbeat(
        healthClient(vi.fn().mockResolvedValue({ data: false, error: null })),
      ),
    ).resolves.toBe(false);
  });
});
