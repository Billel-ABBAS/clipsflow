// Railway Cron entrypoint for the long-form Shorts analysis queue. It processes
// at most one fenced job per invocation; a separate service keeps source-file
// disk usage and AI budgets isolated from short-clip rendering.

export {};

async function main(): Promise<void> {
  if (
    process.env.SHORTS_ANALYSIS_WORKER_ENABLED !== "true" &&
    process.env.SHORTS_ANALYSIS_WORKER_ENABLED !== "1"
  ) {
    console.info(
      JSON.stringify({
        level: "info",
        source: "railway-shorts-analysis-worker",
        message: "worker_disabled",
      }),
    );
    return;
  }

  const [{ createAdminClient }, { processOneShortsAnalysisJob }] =
    await Promise.all([
      import("../src/lib/supabase/admin"),
      import("../src/lib/shorts/analysis-worker"),
    ]);
  const result = await processOneShortsAnalysisJob(createAdminClient());
  console.info(
    JSON.stringify({
      level: "info",
      source: "railway-shorts-analysis-worker",
      message: "worker_complete",
      result: result.kind,
      job_id: "jobId" in result ? result.jobId : undefined,
    }),
  );
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
