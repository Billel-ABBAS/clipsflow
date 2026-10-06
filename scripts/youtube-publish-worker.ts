// Railway Cron entrypoint for confirmed YouTube publications. It is gated
// independently from both render and long-form analysis workers.

export {};

async function main(): Promise<void> {
  if (
    process.env.YOUTUBE_PUBLISH_WORKER_ENABLED !== "true" &&
    process.env.YOUTUBE_PUBLISH_WORKER_ENABLED !== "1"
  ) {
    console.info(
      JSON.stringify({
        level: "info",
        source: "railway-youtube-publish-worker",
        message: "worker_disabled",
      }),
    );
    return;
  }

  const [{ createAdminClient }, { processOneYouTubePublicationJob }] =
    await Promise.all([
      import("../src/lib/supabase/admin"),
      import("../src/lib/youtube/publication-worker"),
    ]);
  const result = await processOneYouTubePublicationJob(createAdminClient());
  console.info(
    JSON.stringify({
      level: result.kind === "unavailable" ? "error" : "info",
      source: "railway-youtube-publish-worker",
      message: "publication_worker_complete",
      result: result.kind,
      publication_id:
        "publicationId" in result ? result.publicationId : undefined,
      video_id: result.kind === "published" ? result.videoId : undefined,
      error_code:
        result.kind === "queued_retry" || result.kind === "failed"
          ? result.errorCode
          : undefined,
    }),
  );
  if (result.kind === "unavailable") process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      level: "error",
      source: "railway-youtube-publish-worker",
      message: "worker_unhandled_error",
      error: message.slice(0, 200),
    }),
  );
  process.exitCode = 1;
});
