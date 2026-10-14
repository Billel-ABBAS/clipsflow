import { describe, expect, it, vi } from "vitest";

import { assertAnalysisQueueEmpty } from "../../../scripts/shorts-local-docker-e2e.mjs";

describe("local Shorts Docker smoke queue guard", () => {
  it("refuses a pre-existing pending row using a read-only query", async () => {
    const commandRunner = vi.fn(async () => ({ code: 0, output: "1" }));

    await expect(
      assertAnalysisQueueEmpty("supabase-db-local", commandRunner),
    ).rejects.toThrow(
      "Refusing to run the local analysis worker poll while the queue is non-empty",
    );
    expect(commandRunner).toHaveBeenCalledOnce();
    expect(commandRunner).toHaveBeenCalledWith("docker", [
      "exec",
      "supabase-db-local",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-At",
      "-c",
      "select count(*) from public.shorts_analysis_jobs where status in ('pending', 'processing')",
    ]);
  });
});
