import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isShortsAnalysisWorkerHeartbeatFresh,
  probeShortsAnalysisWorkerHealthRpc,
  recordShortsAnalysisWorkerHeartbeat,
} from "./analysis-worker-health";

function healthClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as Pick<SupabaseClient, "rpc">;
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it("probes the protected health RPC without recording a heartbeat", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("unavailable") });

    await expect(
      probeShortsAnalysisWorkerHealthRpc(healthClient(rpc)),
    ).resolves.toBe("healthy");
    await expect(
      probeShortsAnalysisWorkerHealthRpc(healthClient(rpc)),
    ).resolves.toBe("stale");
    await expect(
      probeShortsAnalysisWorkerHealthRpc(healthClient(rpc)),
    ).resolves.toBe("unavailable");
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenNthCalledWith(1, "shorts_is_analysis_worker_healthy");
  });

  it("fails closed and aborts a health RPC that never completes", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = new Promise<never>(() => {}) as Promise<never> & {
      abortSignal: (value: AbortSignal) => Promise<never>;
    };
    pending.abortSignal = (value) => {
      signal = value;
      return pending;
    };
    const rpc = vi.fn(() => pending);
    const result = isShortsAnalysisWorkerHeartbeatFresh(healthClient(rpc));

    const expectation = expect(result).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
    expect(signal?.aborted).toBe(true);
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
