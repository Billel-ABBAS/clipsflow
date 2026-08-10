// ClipsFlow — POST /api/billing/webhook
// Reçoit les webhooks Stripe, met à jour profiles.plan.

import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { planFromPriceId } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function updateProfilePlan(
  userId: string,
  plan: string,
  stripeCustomerId: string | null,
  stripeSubscriptionId: string | null,
  status: string,
) {
  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({
      plan,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      subscription_status: status,
    })
    .eq("id", userId);
  if (error) {
    throw error;
  }
}

async function findUserIdByCustomer(customerId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  if (error || !data) return null;
  return data.id;
}

export async function POST(request: Request) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return NextResponse.json({ error: "webhook_secret_missing" }, { status: 500 });
  }

  const headersList = await headers();
  const signature = headersList.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "signature_missing" }, { status: 400 });
  }

  const rawBody = await request.text();
  let event: ReturnType<typeof stripe.webhooks.constructEvent>;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  const admin = createAdminClient();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as {
        metadata?: { user_id?: string; plan?: string };
        customer?: string;
        subscription?: string;
      };
      const userId = session.metadata?.user_id;
      const plan = session.metadata?.plan;
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      if (userId && plan) {
        await updateProfilePlan(
          userId,
          plan,
          customerId ?? null,
          subscriptionId ?? null,
          "active",
        );
      }
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as {
        id: string;
        customer: string;
        status: string;
        items?: { data: Array<{ price?: { id?: string } }> };
      };
      const userId = await findUserIdByCustomer(subscription.customer);
      if (userId) {
        const priceId = subscription.items?.data?.[0]?.price?.id ?? null;
        const plan = planFromPriceId(priceId) ?? "free";
        await updateProfilePlan(
          userId,
          plan,
          subscription.customer,
          subscription.id,
          subscription.status,
        );
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as {
        customer: string;
      };
      const userId = await findUserIdByCustomer(subscription.customer);
      if (userId) {
        await updateProfilePlan(
          userId,
          "free",
          subscription.customer,
          null,
          "canceled",
        );
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as { customer?: string };
      if (invoice.customer) {
        const userId = await findUserIdByCustomer(invoice.customer);
        if (userId) {
          await admin
            .from("profiles")
            .update({ subscription_status: "past_due" })
            .eq("id", userId);
        }
      }
      break;
    }

    default:
      // ignore autres events
      break;
  }

  return NextResponse.json({ received: true });
}
