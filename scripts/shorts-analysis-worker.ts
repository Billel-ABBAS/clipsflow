import { runShortsAnalysisWorkerEntrypoint } from "../src/lib/shorts/analysis-worker-entrypoint";
import { resolveShortsAnalysisWorkerRunMode } from "../src/lib/shorts/analysis-worker-run-mode";

// Railway Cron entrypoint for the long-form Shorts analysis queue. It processes
// at most one fenced job per invocation; a separate service keeps source-file
// disk usage and AI budgets isolated from short-clip rendering.

export {};

function report(entry: Record<string, unknown>): void {
  console.info(JSON.stringify(entry));
}

async function main(): Promise<void> {
  const runMode = resolveShortsAnalysisWorkerRunMode({
    SHORTS_ANALYSIS_WORKER_ENABLED: process.env.SHORTS_ANALYSIS_WORKER_ENABLED,
    SHORTS_ANALYSIS_WORKER_VERIFY_ONLY:
      process.env.SHORTS_ANALYSIS_WORKER_VERIFY_ONLY,
  });
  if (runMode === "verify-only") {
    const [{ createAdminClient }, { probeShortsAnalysisWorkerHealthRpc }] =
      await Promise.all([
        import("../src/lib/supabase/admin"),
        import("../src/lib/shorts/analysis-worker-health"),
      ]);
    await runShortsAnalysisWorkerEntrypoint({
      mode: runMode,
      createAdminClient,
      probeWorkerHealth: probeShortsAnalysisWorkerHealthRpc,
      report,
      setExitCode: (exitCode) => {
        process.exitCode = exitCode;
      },
    });
    return;
  }

  if (runMode === "disabled") {
    await runShortsAnalysisWorkerEntrypoint({
      mode: runMode,
      report,
      setExitCode: (exitCode) => {
        process.exitCode = exitCode;
      },
    });
    return;
  }

  const [
    { createAdminClient },
    { processOneShortsAnalysisJob },
    { recordShortsAnalysisWorkerHeartbeat },
  ] = await Promise.all([
    import("../src/lib/supabase/admin"),
    import("../src/lib/shorts/analysis-worker"),
    import("../src/lib/shorts/analysis-worker-health"),
  ]);
  await runShortsAnalysisWorkerEntrypoint({
    mode: runMode,
    createAdminClient,
    processOneJob: processOneShortsAnalysisJob,
    recordHeartbeat: recordShortsAnalysisWorkerHeartbeat,
    report,
    setExitCode: (exitCode) => {
      process.exitCode = exitCode;
    },
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      level: "error",
      source: "railway-shorts-analysis-worker",
      message: "worker_unhandled_error",
      error: message.slice(0, 400),
    }),
  );
  process.exitCode = 1;
});
