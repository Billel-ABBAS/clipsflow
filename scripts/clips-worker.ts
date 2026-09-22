// Railway Cron entrypoint. It deliberately processes at most one render and
// then exits, so Railway's five-minute scheduler remains the only dispatcher.

async function main(): Promise<void> {
  if (
    process.env.CLIPS_WORKER_ENABLED !== "true" &&
    process.env.CLIPS_WORKER_ENABLED !== "1"
  ) {
    console.info(
      JSON.stringify({
        level: "info",
        source: "railway-clips-worker",
        message: "worker_disabled",
      }),
    );
    return;
  }

  const [{ createAdminClient }, { processOneRenderJob }] = await Promise.all([
    import("../src/lib/supabase/admin"),
    import("../src/lib/clips/render-worker"),
  ]);
  const result = await processOneRenderJob(createAdminClient());
  console.info(
    JSON.stringify({
      level: "info",
      source: "railway-clips-worker",
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
      source: "railway-clips-worker",
      message: "worker_unhandled_error",
      error: message.slice(0, 400),
    }),
  );
  process.exitCode = 1;
});
