import type { SupabaseClient } from "@supabase/supabase-js";
import { withAnalysisRequestTimeout } from "./analysis-request";

type AnalysisWorkerHealthClient = Pick<SupabaseClient, "rpc">;

/**
 * These RPCs are restricted to service_role and return only a boolean. Missing
 * migrations, transport errors, and unexpected payloads all fail closed.
 */
export async function isShortsAnalysisWorkerHeartbeatFresh(
  admin: AnalysisWorkerHealthClient,
): Promise<boolean> {
  try {
    const { data, error } = await withAnalysisRequestTimeout(
      admin.rpc("shorts_is_analysis_worker_healthy"),
    );
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * Executes only the protected, read-only health RPC. This is used during a
 * post-rotation verification before a worker may poll or claim the queue.
 */
export async function probeShortsAnalysisWorkerHealthRpc(
  admin: AnalysisWorkerHealthClient,
): Promise<"healthy" | "stale" | "unavailable"> {
  try {
    const { data, error } = await withAnalysisRequestTimeout(
      admin.rpc("shorts_is_analysis_worker_healthy"),
    );
    if (error || typeof data !== "boolean") return "unavailable";
    return data ? "healthy" : "stale";
  } catch {
    return "unavailable";
  }
}

export async function recordShortsAnalysisWorkerHeartbeat(
  admin: AnalysisWorkerHealthClient,
): Promise<boolean> {
  try {
    const { data, error } = await withAnalysisRequestTimeout(
      admin.rpc("shorts_record_analysis_worker_heartbeat"),
    );
    return !error && data === true;
  } catch {
    return false;
  }
}
