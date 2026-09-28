import type { SupabaseClient } from "@supabase/supabase-js";

export type StripeSubscriptionStatus =
  | "none"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export class StripeWebhookStateError extends Error {
  constructor(operation: string) {
    super(`stripe_webhook_state:${operation}_failed`);
    this.name = "StripeWebhookStateError";
  }
}

export async function claimStripeWebhookEvent(
  supabase: SupabaseClient,
  event: { id: string; created: number; type: string },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("stripe_claim_webhook_event", {
    p_event_id: event.id,
    p_event_created: event.created,
    p_event_type: event.type,
  });
  if (error || (data !== "process" && data !== "skip")) {
    throw new StripeWebhookStateError("claim");
  }
  return data === "process";
}

export async function completeStripeWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
): Promise<void> {
  const { error } = await supabase.rpc("stripe_complete_webhook_event", {
    p_event_id: eventId,
  });
  if (error) throw new StripeWebhookStateError("complete");
}

function safeFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "webhook_processing_failed";
  const message = error.message.trim();
  return message ? message.slice(0, 500) : "webhook_processing_failed";
}

export async function failStripeWebhookEvent(
  supabase: SupabaseClient,
  eventId: string,
  error: unknown,
): Promise<void> {
  const { error: rpcError } = await supabase.rpc("stripe_fail_webhook_event", {
    p_event_id: eventId,
    p_error: safeFailureMessage(error),
  });
  if (rpcError) throw new StripeWebhookStateError("fail");
}

export interface ApplyStripeProfileEventInput {
  userId: string;
  eventCreated: number;
  plan: "free" | "solo" | "pro" | "studio" | null;
  customerId: string | null;
  subscriptionId: string | null;
  status: StripeSubscriptionStatus;
  clearSubscription: boolean;
}

export async function applyStripeProfileEvent(
  supabase: SupabaseClient,
  input: ApplyStripeProfileEventInput,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("stripe_apply_profile_event", {
    p_user_id: input.userId,
    p_event_created: input.eventCreated,
    p_plan: input.plan,
    p_customer_id: input.customerId,
    p_subscription_id: input.subscriptionId,
    p_status: input.status,
    p_clear_subscription: input.clearSubscription,
  });
  if (error || typeof data !== "boolean") {
    throw new StripeWebhookStateError("apply_profile");
  }
  return data;
}
