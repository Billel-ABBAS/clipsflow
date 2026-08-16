import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { planFromPriceId } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe-server";
import {
  applyStripeProfileEvent,
  claimStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
  type StripeSubscriptionStatus,
} from "@/lib/billing/webhook-state";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const SUBSCRIPTION_STATUSES = new Set<StripeSubscriptionStatus>([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);

function isSubscriptionStatus(
  value: string,
): value is StripeSubscriptionStatus {
  return SUBSCRIPTION_STATUSES.has(value as StripeSubscriptionStatus);
}

function expandableId(value: { id: string } | string | null): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

async function findUserIdByCustomer(
  admin: SupabaseClient,
  customerId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (error) throw new Error("stripe_customer_lookup_failed");
  return (data?.id as string | undefined) ?? null;
}

async function processSubscription(
  admin: SupabaseClient,
  event: Stripe.Event,
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId = expandableId(subscription.customer);
  if (!customerId || !isSubscriptionStatus(subscription.status)) return;

  const userId =
    subscription.metadata.user_id ??
    (await findUserIdByCustomer(admin, customerId));
  if (!userId) return;

  const priceId = subscription.items.data[0]?.price.id ?? null;
  const plan = planFromPriceId(priceId) ?? "free";
  await applyStripeProfileEvent(admin, {
    userId,
    eventCreated: event.created,
    plan,
    customerId,
    subscriptionId: subscription.id,
    status: subscription.status,
    clearSubscription: false,
  });
}

async function processVerifiedEvent(
  admin: SupabaseClient,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const subscriptionId = expandableId(session.subscription);
      if (!subscriptionId) return;
      const subscription =
        await getStripe().subscriptions.retrieve(subscriptionId);
      await processSubscription(admin, event, subscription);
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
      await processSubscription(admin, event, event.data.object);
      return;

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const customerId = expandableId(subscription.customer);
      if (!customerId) return;
      const userId =
        subscription.metadata.user_id ??
        (await findUserIdByCustomer(admin, customerId));
      if (!userId) return;

      await applyStripeProfileEvent(admin, {
        userId,
        eventCreated: event.created,
        plan: "free",
        customerId,
        subscriptionId: null,
        status: "canceled",
        clearSubscription: true,
      });
      return;
    }

    case "invoice.payment_failed": {
      const customerId = expandableId(event.data.object.customer);
      if (!customerId) return;
      const userId = await findUserIdByCustomer(admin, customerId);
      if (!userId) return;

      await applyStripeProfileEvent(admin, {
        userId,
        eventCreated: event.created,
        plan: null,
        customerId,
        subscriptionId: null,
        status: "past_due",
        clearSubscription: false,
      });
      return;
    }

    default:
      return;
  }
}

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json(
      { error: "webhook_secret_missing" },
      { status: 500 },
    );
  }

  const signature = (await headers()).get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "signature_missing" }, { status: 400 });
  }

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      await request.text(),
      signature,
      webhookSecret,
    );
  } catch {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  const admin = createAdminClient();
  let shouldProcess: boolean;
  try {
    shouldProcess = await claimStripeWebhookEvent(admin, event);
  } catch {
    return NextResponse.json(
      { error: "webhook_state_unavailable" },
      { status: 503 },
    );
  }

  if (!shouldProcess) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    await processVerifiedEvent(admin, event);
    await completeStripeWebhookEvent(admin, event.id);
    return NextResponse.json({ received: true });
  } catch (error) {
    try {
      await failStripeWebhookEvent(admin, event.id, error);
    } catch {
      // The 500 below asks Stripe to retry; no raw error is exposed.
    }
    return NextResponse.json(
      { error: "webhook_processing_failed" },
      { status: 500 },
    );
  }
}
