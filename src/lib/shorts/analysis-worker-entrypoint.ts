import type {
  ShortsAnalysisWorkerDependencies,
  ShortsAnalysisWorkerResult,
} from "./analysis-worker";
import type { ShortsAnalysisWorkerRunMode } from "./analysis-worker-run-mode";

export type ShortsAnalysisWorkerHealth = "healthy" | "stale" | "unavailable";

type WorkerLogEntry = {
  level: "error" | "info";
  source: "railway-shorts-analysis-worker";
  message:
    | "worker_complete"
    | "worker_disabled"
    | "worker_verify_only_complete";
  health?: ShortsAnalysisWorkerHealth;
  job_id?: string;
  result?: ShortsAnalysisWorkerResult["kind"];
};

type WorkerProcessingDependencies = Pick<
  ShortsAnalysisWorkerDependencies,
  "onSuccessfulQueuePoll" | "refreshWorkerHeartbeat"
>;

/**
 * The entrypoint is intentionally dependency-injected so the verify-only
 * boundary is testable without opening a database connection. In particular,
 * that mode must never load or call the queue processor or heartbeat writer.
 */
export interface ShortsAnalysisWorkerEntrypointDependencies<TAdmin> {
  mode: ShortsAnalysisWorkerRunMode;
  createAdminClient?: () => TAdmin;
  probeWorkerHealth?: (admin: TAdmin) => Promise<ShortsAnalysisWorkerHealth>;
  processOneJob?: (
    admin: TAdmin,
    dependencies: WorkerProcessingDependencies,
  ) => Promise<ShortsAnalysisWorkerResult>;
  recordHeartbeat?: (admin: TAdmin) => Promise<boolean>;
  report: (entry: WorkerLogEntry) => void;
  setExitCode: (exitCode: number) => void;
}

function requireDependency<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`shorts_analysis_worker_missing_${name}`);
  return value;
}

export async function runShortsAnalysisWorkerEntrypoint<TAdmin>(
  dependencies: ShortsAnalysisWorkerEntrypointDependencies<TAdmin>,
): Promise<void> {
  if (dependencies.mode === "disabled") {
    dependencies.report({
      level: "info",
      source: "railway-shorts-analysis-worker",
      message: "worker_disabled",
    });
    return;
  }

  const createAdminClient = requireDependency(
    dependencies.createAdminClient,
    "admin_client",
  );
  const admin = createAdminClient();

  if (dependencies.mode === "verify-only") {
    const probeWorkerHealth = requireDependency(
      dependencies.probeWorkerHealth,
      "health_probe",
    );
    const health = await probeWorkerHealth(admin);
    dependencies.report({
      level: health === "unavailable" ? "error" : "info",
      source: "railway-shorts-analysis-worker",
      message: "worker_verify_only_complete",
      health,
    });
    if (health === "unavailable") dependencies.setExitCode(1);
    return;
  }

  const processOneJob = requireDependency(
    dependencies.processOneJob,
    "queue_processor",
  );
  const recordHeartbeat = requireDependency(
    dependencies.recordHeartbeat,
    "heartbeat_writer",
  );
  const heartbeat = () => recordHeartbeat(admin);
  const result = await processOneJob(admin, {
    onSuccessfulQueuePoll: heartbeat,
    refreshWorkerHeartbeat: heartbeat,
  });
  dependencies.report({
    level: "info",
    source: "railway-shorts-analysis-worker",
    message: "worker_complete",
    result: result.kind,
    job_id: "jobId" in result ? result.jobId : undefined,
  });
}
