import { describe, expect, it, vi } from "vitest";

import { runShortsAnalysisWorkerEntrypoint } from "./analysis-worker-entrypoint";

describe("runShortsAnalysisWorkerEntrypoint", () => {
  it("does not claim a job or write a heartbeat in verify-only mode", async () => {
    const admin = { label: "test-admin" };
    const createAdminClient = vi.fn(() => admin);
    const probeWorkerHealth = vi.fn().mockResolvedValue("healthy");
    const processOneJob = vi.fn();
    const recordHeartbeat = vi.fn();
    const report = vi.fn();
    const setExitCode = vi.fn();

    await runShortsAnalysisWorkerEntrypoint({
      mode: "verify-only",
      createAdminClient,
      probeWorkerHealth,
      processOneJob,
      recordHeartbeat,
      report,
      setExitCode,
    });

    expect(createAdminClient).toHaveBeenCalledOnce();
    expect(probeWorkerHealth).toHaveBeenCalledWith(admin);
    expect(processOneJob).not.toHaveBeenCalled();
    expect(recordHeartbeat).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      level: "info",
      source: "railway-shorts-analysis-worker",
      message: "worker_verify_only_complete",
      health: "healthy",
    });
  });

  it("fails the cron check without opening the queue when the health RPC is unavailable", async () => {
    const admin = { label: "test-admin" };
    const processOneJob = vi.fn();
    const recordHeartbeat = vi.fn();
    const setExitCode = vi.fn();

    await runShortsAnalysisWorkerEntrypoint({
      mode: "verify-only",
      createAdminClient: () => admin,
      probeWorkerHealth: vi.fn().mockResolvedValue("unavailable"),
      processOneJob,
      recordHeartbeat,
      report: vi.fn(),
      setExitCode,
    });

    expect(processOneJob).not.toHaveBeenCalled();
    expect(recordHeartbeat).not.toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("does not even create an admin client while disabled", async () => {
    const createAdminClient = vi.fn();

    await runShortsAnalysisWorkerEntrypoint({
      mode: "disabled",
      createAdminClient,
      report: vi.fn(),
      setExitCode: vi.fn(),
    });

    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("keeps the established worker heartbeat callbacks in processing mode", async () => {
    const admin = { label: "test-admin" };
    const recordHeartbeat = vi.fn().mockResolvedValue(true);
    const processOneJob = vi.fn().mockResolvedValue({ kind: "idle" });
    const report = vi.fn();

    await runShortsAnalysisWorkerEntrypoint({
      mode: "process-one",
      createAdminClient: () => admin,
      processOneJob,
      recordHeartbeat,
      report,
      setExitCode: vi.fn(),
    });

    expect(processOneJob).toHaveBeenCalledOnce();
    expect(processOneJob).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        onSuccessfulQueuePoll: expect.any(Function),
        refreshWorkerHeartbeat: expect.any(Function),
      }),
    );
    const workerDependencies = processOneJob.mock.calls[0]?.[1] as {
      onSuccessfulQueuePoll: () => Promise<boolean>;
      refreshWorkerHeartbeat: () => Promise<boolean>;
    };
    await workerDependencies.onSuccessfulQueuePoll();
    await workerDependencies.refreshWorkerHeartbeat();
    expect(recordHeartbeat).toHaveBeenCalledTimes(2);
    expect(recordHeartbeat).toHaveBeenCalledWith(admin);
    expect(report).toHaveBeenCalledWith({
      level: "info",
      source: "railway-shorts-analysis-worker",
      message: "worker_complete",
      result: "idle",
      job_id: undefined,
    });
  });
});
