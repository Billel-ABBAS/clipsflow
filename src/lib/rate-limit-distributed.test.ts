import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DistributedRateLimitError,
  checkDistributedRateLimit,
} from "./rate-limit-distributed";

function rpcClient(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient;
}

describe("checkDistributedRateLimit", () => {
  it("retourne allowed et transmet la fenêtre au RPC", async () => {
    const client = rpcClient({
      data: [{ allowed: true, retry_after_seconds: 0 }],
      error: null,
    });

    await expect(
      checkDistributedRateLimit(client, "jobs:user-1", 10, 60),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(client.rpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_key: "jobs:user-1",
      p_limit: 10,
      p_window_seconds: 60,
    });
  });

  it("conserve le Retry-After d'un refus", async () => {
    const client = rpcClient({
      data: [{ allowed: false, retry_after_seconds: 42 }],
      error: null,
    });

    await expect(
      checkDistributedRateLimit(client, "checkout:user-1", 5, 300),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it("échoue fermé lorsque Postgres est indisponible", async () => {
    const client = rpcClient({
      data: null,
      error: { message: "connection detail" },
    });

    const thrown = await checkDistributedRateLimit(
      client,
      "jobs:user-1",
      10,
      60,
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DistributedRateLimitError);
    expect((thrown as Error).message).not.toContain("connection detail");
  });

  it.each<[unknown]>([
    [[]],
    [[{ allowed: "yes", retry_after_seconds: 0 }]],
    [[{ allowed: true, retry_after_seconds: -1 }]],
    [
      [
        { allowed: true, retry_after_seconds: 0 },
        { allowed: true, retry_after_seconds: 0 },
      ],
    ],
  ])("rejette une réponse RPC malformée", async (data) => {
    const client = rpcClient({ data, error: null });

    await expect(
      checkDistributedRateLimit(client, "jobs:user-1", 10, 60),
    ).rejects.toBeInstanceOf(DistributedRateLimitError);
  });
});
