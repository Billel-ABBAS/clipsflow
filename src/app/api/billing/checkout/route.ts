// ClipsFlow — POST /api/billing/checkout
// Crée une session Stripe Checkout (mode subscription) pour le plan demandé.

import { NextResponse } from "next/server";
import { z } from "zod";

import { BILLING_PLANS, PAID_PLANS } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe-server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";
import { getTrustedAppUrl } from "@/lib/http/trusted-app-url";

const checkoutSchema = z.strictObject({
  plan: z.enum(PAID_PLANS),
  request_id: z.uuid(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `checkout:${user.id}`,
      5,
      300,
    );
  } catch {
    return NextResponse.json(
      { error: "rate_limit_unavailable" },
      { status: 503 },
    );
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": rateLimit.retryAfterSeconds.toString(),
        },
      },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = checkoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  const { plan: planLower, request_id: requestId } = parsed.data;
  const billingPlan = BILLING_PLANS[planLower];
  if (!billingPlan.priceId) {
    return NextResponse.json(
      { error: "price_not_configured" },
      { status: 503 },
    );
  }

  let appUrl: URL;
  try {
    appUrl = getTrustedAppUrl();
  } catch {
    return NextResponse.json(
      { error: "app_url_not_configured" },
      { status: 503 },
    );
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select(
      "id, stripe_customer_id, stripe_subscription_id, subscription_status, email, full_name",
    )
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }

  if (
    profile.stripe_subscription_id &&
    !["none", "canceled", "incomplete_expired"].includes(
      profile.subscription_status,
    )
  ) {
    return NextResponse.json({ error: "subscription_exists" }, { status: 409 });
  }

  const stripe = getStripe();

  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        email: profile.email ?? undefined,
        name: profile.full_name ?? undefined,
        metadata: { user_id: user.id },
      },
      { idempotencyKey: `clipsflow:customer:${user.id}` },
    );
    customerId = customer.id;
    const { error: persistCustomerError } = await admin
      .from("profiles")
      .update({ stripe_customer_id: customerId })
      .eq("id", user.id);
    if (persistCustomerError) {
      return NextResponse.json(
        { error: "customer_persist_failed" },
        { status: 503 },
      );
    }
  }

  const session = await stripe.checkout.sessions.create(
    {
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: billingPlan.priceId, quantity: 1 }],
      success_url: new URL("/clips?upgraded=1", appUrl).href,
      cancel_url: new URL("/pricing", appUrl).href,
      metadata: { user_id: user.id, plan: planLower },
      subscription_data: {
        metadata: { user_id: user.id, plan: planLower },
      },
      allow_promotion_codes: true,
    },
    { idempotencyKey: `clipsflow:checkout:${user.id}:${requestId}` },
  );

  return NextResponse.json({ url: session.url });
}
