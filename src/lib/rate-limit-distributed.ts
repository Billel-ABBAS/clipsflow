import type { SupabaseClient } from "@supabase/supabase-js";

export interface DistributedRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class DistributedRateLimitError extends Error {
  constructor() {
    super("distributed_rate_limit:unavailable");
    this.name = "DistributedRateLimitError";
  }
}

export async function checkDistributedRateLimit(
  supabase: SupabaseClient,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<DistributedRateLimitResult> {
  if (
    key.length < 1 ||
    key.length > 256 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 1
  ) {
    throw new DistributedRateLimitError();
  }

  const { data, error } = await supabase.rpc("consume_api_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error || !Array.isArray(data) || data.length !== 1) {
    throw new DistributedRateLimitError();
  }

  const row = data[0] as Record<string, unknown> | null;
  if (
    !row ||
    typeof row.allowed !== "boolean" ||
    typeof row.retry_after_seconds !== "number" ||
    !Number.isInteger(row.retry_after_seconds) ||
    row.retry_after_seconds < 0
  ) {
    throw new DistributedRateLimitError();
  }

  return {
    allowed: row.allowed,
    retryAfterSeconds: row.retry_after_seconds,
  };
}
