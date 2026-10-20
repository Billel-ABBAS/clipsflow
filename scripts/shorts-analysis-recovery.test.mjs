import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recoverShortsAnalysis,
  WORKER_SHA,
} from "./shorts-analysis-recovery.mjs";

const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "Billel-ABBAS/clipsflow",
  GITHUB_RUN_ID: "123",
  SHORTS_RECOVERY_WORKER_SHA: WORKER_SHA,
  SHORTS_RECOVERY_MODE: "probe",
  SHORTS_ANALYSIS_WORKER_ENABLED: "true",
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  NEXT_PUBLIC_SUPABASE_URL: "https://ifwdzqzoqwitahffrvcr.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-private-key",
  OPENAI_API_KEY: "fixture-openai",
  GROQ_API_KEY: "fixture-groq",
};
const idle = {
  status: 0,
  stdout: '{"message":"worker_complete","result":"idle"}',
};
function setup(overrides = {}) {
  let workerCalls = 0,
    runtimeCalls = 0;
  return {
    options: {
      environment: { ...environment },
      checkRuntime: async () => ({ workerHealthy: ++runtimeCalls > 1 }),
      fetchImplementation: async () => ({ ok: true, json: async () => [] }),
      runWorker: () => {
        workerCalls++;
        return idle;
      },
      ...overrides,
    },
    workerCalls: () => workerCalls,
  };
}
test("probe requires an empty queue and a real successful worker poll", async () => {
  const fixture = setup();
  const result = await recoverShortsAnalysis(fixture.options);
  assert.equal(fixture.workerCalls(), 1);
  assert.equal(result.source, "github-actions-shorts-analysis");
  assert.equal(result.workerHealthy, true);
  assert.equal(result.completeShortsJourneyVerified, false);
  assert.equal(JSON.stringify(result).includes("fixture-private-key"), false);
});
test("probe refuses an occupied or unavailable queue before invoking the worker", async () => {
  for (const response of [
    { ok: true, json: async () => [{ id: "existing" }] },
    { ok: false },
  ]) {
    const fixture = setup({ fetchImplementation: async () => response });
    await assert.rejects(
      recoverShortsAnalysis(fixture.options),
      /queue_not_proven_empty/u,
    );
    assert.equal(fixture.workerCalls(), 0);
  }
});
test("rejects wrong target, untrusted runner, absent keys and unknown mode", async () => {
  for (const patch of [
    { NEXT_PUBLIC_SUPABASE_URL: "https://other.invalid" },
    { GITHUB_REPOSITORY: "other/repo" },
    { SHORTS_RECOVERY_WORKER_SHA: "other" },
    { OPENAI_API_KEY: "" },
    { SHORTS_RECOVERY_MODE: "unbounded" },
  ]) {
    const fixture = setup({ environment: { ...environment, ...patch } });
    await assert.rejects(recoverShortsAnalysis(fixture.options), /recovery_/u);
    assert.equal(fixture.workerCalls(), 0);
  }
});
test("never accepts disabled, unavailable, errored or missing worker completion", async () => {
  for (const worker of [
    { status: 1 },
    { ...idle, error: new Error("private") },
    { status: 0, stdout: '{"message":"worker_disabled"}' },
    {
      ...idle,
      stdout: '{"message":"worker_prerequisites_unavailable"}\n' + idle.stdout,
    },
    {
      ...idle,
      stderr: '{"level":"error","message":"worker_heartbeat_write_failed"}',
    },
    {
      ...idle,
      stdout:
        '{"level":"error","message":"worker_heartbeat_write_failed"}\n' +
        idle.stdout,
    },
  ]) {
    await assert.rejects(
      recoverShortsAnalysis(setup({ runWorker: () => worker }).options),
      /recovery_/u,
    );
  }
});
test("fresh prior health cannot replace post-run heartbeat proof", async () => {
  let reads = 0;
  await assert.rejects(
    recoverShortsAnalysis(
      setup({ checkRuntime: async () => ({ workerHealthy: ++reads === 1 }) })
        .options,
    ),
    /no_real_heartbeat/u,
  );
});
test("rejects processing mode and any unexpected completed job", async () => {
  const fixture = setup({
    environment: { ...environment, SHORTS_RECOVERY_MODE: "process-one" },
  });
  await assert.rejects(recoverShortsAnalysis(fixture.options), /invalid_mode/u);
  assert.equal(fixture.workerCalls(), 0);
  await assert.rejects(
    recoverShortsAnalysis(
      setup({
        runWorker: () => ({
          ...idle,
          stdout: '{"message":"worker_complete","result":"completed"}',
        }),
      }).options,
    ),
    /worker_not_ready/u,
  );
});
