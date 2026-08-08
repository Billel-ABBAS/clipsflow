// ClipsFlow — POST /api/billing/checkout
// Crée une session Stripe Checkout (mode subscription) pour le plan demandé.

import { NextResponse } from "next/server";
import { redirect } from "next/navigation";

import { BILLING_PLANS, PAID_PLANS } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe-server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { plan } = await request.json().catch(() => ({}));
  if (!plan || typeof plan !== "string") {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  const planLower = plan.toLowerCase() as keyof typeof BILLING_PLANS;
  if (!PAID_PLANS.includes(planLower as typeof PAID_PLANS[number])) {
    return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  }
  const billingPlan = BILLING_PLANS[planLower];
  if (!billingPlan.priceId) {
    return NextResponse.json(
      { error: "price_not_configured" },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, stripe_customer_id, email, full_name")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }

  const stripe = getStripe();

  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: profile.email ?? undefined,
      name: profile.full_name ?? undefined,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
    await admin
      .from("profiles")
      .update({ stripe_customer_id: customerId })
      .eq("id", user.id);
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: billingPlan.priceId, quantity: 1 }],
    success_url: `${origin}/clips?upgraded=1`,
    cancel_url: `${origin}/pricing`,
    metadata: { user_id: user.id, plan: planLower },
    subscription_data: {
      metadata: { user_id: user.id, plan: planLower },
    },
    allow_promotion_codes: true,
  });

  return NextResponse.json({ url: session.url });
}
