// ClipsFlow — GET /api/billing/portal
// Redirige vers le portail client Stripe (gestion / annulation abonnement).

import { NextResponse } from "next/server";

import { getStripe } from "@/lib/billing/stripe-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getTrustedAppUrl } from "@/lib/http/trusted-app-url";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .single();

  if (error || !profile?.stripe_customer_id) {
    return NextResponse.json({ error: "no_subscription" }, { status: 404 });
  }

  const stripe = getStripe();
  let appUrl: URL;
  try {
    appUrl = getTrustedAppUrl();
  } catch {
    return NextResponse.json(
      { error: "app_url_not_configured" },
      { status: 503 },
    );
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: new URL("/clips", appUrl).href,
  });

  return NextResponse.redirect(session.url);
}
