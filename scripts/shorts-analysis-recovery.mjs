import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const WORKER_SHA = "e2592d79cd0fd5aa1239b37f715904f42f5f5e3e";
const PROJECT_REF = "ifwdzqzoqwitahffrvcr";
const ORIGIN = `https://${PROJECT_REF}.supabase.co`;

export async function recoverShortsAnalysis({
  environment = process.env,
  checkRuntime,
  fetchImplementation = fetch,
  runWorker = () =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/shorts-analysis-worker.ts"],
      {
        encoding: "utf8",
        maxBuffer: 1_048_576,
        timeout: 90_000,
      },
    ),
} = {}) {
  const mode = environment.SHORTS_RECOVERY_MODE;
  if (mode !== "probe") throw new Error("recovery_invalid_mode");
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_REPOSITORY !== "Billel-ABBAS/clipsflow" ||
    environment.SHORTS_RECOVERY_WORKER_SHA !== WORKER_SHA ||
    !/^\d+$/u.test(environment.GITHUB_RUN_ID ?? "")
  ) {
    throw new Error("recovery_runner_identity_invalid");
  }
  if (
    environment.NEXT_PUBLIC_SUPABASE_URL !== ORIGIN ||
    !environment.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    !environment.OPENAI_API_KEY?.trim() ||
    !environment.GROQ_API_KEY?.trim() ||
    environment.SHORTS_ANALYSIS_WORKER_ENABLED !== "true" ||
    environment.CLIPS_AI_BUDGET_AUTHORIZED !== "true"
  ) {
    throw new Error("recovery_configuration_invalid");
  }
  const key = environment.SUPABASE_SERVICE_ROLE_KEY.trim();
  const headers = { apikey: key, Accept: "application/json" };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  async function readJson(path) {
    const response = await fetchImplementation(`${ORIGIN}/rest/v1${path}`, {
      method: "GET",
      headers,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("recovery_api_unavailable");
    return response.json();
  }
  const runtimeOptions = { projectRef: PROJECT_REF, environment };
  const readRuntime =
    checkRuntime ??
    (async () => {
      const workerHealthy = await readJson(
        "/rpc/shorts_is_analysis_worker_healthy",
      );
      if (typeof workerHealthy !== "boolean")
        throw new Error("recovery_health_invalid");
      return { workerHealthy };
    });
  await readRuntime(runtimeOptions);
  async function assertEmptyQueue() {
    try {
      const rows = await readJson("/shorts_analysis_jobs?select=id&limit=1");
      if (!Array.isArray(rows) || rows.length !== 0) throw new Error();
    } catch {
      throw new Error("recovery_queue_not_proven_empty");
    }
  }
  await assertEmptyQueue();
  const worker = runWorker();
  if (worker.status !== 0 || worker.error || worker.signal)
    throw new Error("recovery_worker_failed");
  const records = `${worker.stdout ?? ""}\n${worker.stderr ?? ""}`
    .split(/\r?\n/u)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const completion = records.find(
    (record) => record?.message === "worker_complete",
  );
  const failure = records.some(
    (record) =>
      record?.level === "error" ||
      ["worker_disabled", "worker_prerequisites_unavailable"].includes(
        record?.message,
      ),
  );
  if (failure || !completion || completion.result !== "idle") {
    throw new Error("recovery_worker_not_ready");
  }
  await assertEmptyQueue();
  const runtime = await readRuntime(runtimeOptions);
  if (!runtime.workerHealthy) throw new Error("recovery_no_real_heartbeat");
  return {
    source: "github-actions-shorts-analysis",
    mode,
    workerCommit: WORKER_SHA,
    runId: environment.GITHUB_RUN_ID,
    workerResult: completion.result,
    workerHealthy: true,
    emptyQueueVerified: true,
    completeShortsJourneyVerified: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  recoverShortsAnalysis()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          source: "github-actions-shorts-analysis",
          error: /^recovery_[a-z_]+$/u.test(error?.message)
            ? error.message
            : "recovery_failed",
        }),
      );
      process.exitCode = 1;
    });
}
