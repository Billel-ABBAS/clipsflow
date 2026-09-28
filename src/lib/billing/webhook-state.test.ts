import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  StripeWebhookStateError,
  applyStripeProfileEvent,
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
} from "./webhook-state";

function rpcClient(results: Array<{ data: unknown; error: unknown }>) {
  const rpc = vi.fn();
  for (const result of results) rpc.mockResolvedValueOnce(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("état des webhooks Stripe", () => {
  it("traite le premier claim et ignore un doublon déjà possédé", async () => {
    const { client } = rpcClient([
      { data: "process", error: null },
      { data: "skip", error: null },
    ]);
    const event = {
      id: "evt_123",
      created: 1_800_000_000,
      type: "customer.subscription.updated",
    };

    await expect(claimStripeWebhookEvent(client, event)).resolves.toBe(true);
    await expect(claimStripeWebhookEvent(client, event)).resolves.toBe(false);
  });

  it("persiste succès et échec via des RPC dédiés", async () => {
    const { client, rpc } = rpcClient([
      { data: null, error: null },
      { data: null, error: null },
    ]);

    await completeStripeWebhookEvent(client, "evt_ok");
    await failStripeWebhookEvent(client, "evt_failed", new Error("boom"));

    expect(rpc).toHaveBeenNthCalledWith(1, "stripe_complete_webhook_event", {
      p_event_id: "evt_ok",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "stripe_fail_webhook_event", {
      p_event_id: "evt_failed",
      p_error: "boom",
    });
  });

  it("borne l'erreur persistée et ne sérialise jamais un objet arbitraire", async () => {
    const { client, rpc } = rpcClient([{ data: null, error: null }]);

    await failStripeWebhookEvent(client, "evt_failed", { secret: "value" });

    expect(rpc).toHaveBeenCalledWith("stripe_fail_webhook_event", {
      p_event_id: "evt_failed",
      p_error: "webhook_processing_failed",
    });
  });

  it("retourne false pour un événement de profil obsolète", async () => {
    const { client } = rpcClient([{ data: false, error: null }]);

    await expect(
      applyStripeProfileEvent(client, {
        userId: "user-1",
        eventCreated: 100,
        plan: "pro",
        customerId: "cus_1",
        subscriptionId: "sub_1",
        status: "active",
        clearSubscription: false,
      }),
    ).resolves.toBe(false);
  });

  it("échoue fermé sur une erreur ou une réponse RPC inconnue", async () => {
    const { client } = rpcClient([
      { data: null, error: { message: "database detail" } },
    ]);

    const thrown = await claimStripeWebhookEvent(client, {
      id: "evt_123",
      created: 100,
      type: "invoice.payment_failed",
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(StripeWebhookStateError);
    expect((thrown as Error).message).not.toContain("database detail");
  });
});
