// ClipsFlow Billing — source unique des plans payants Stripe
// Plan → quotaSeconds + priceId Stripe. Réutilise QUOTAS_SECONDS de quota.ts.

import { QUOTAS_SECONDS, type Plan } from "@/lib/clips/quota";

export interface BillingPlan {
  plan: Plan;
  priceId: string | null; // null = free (pas de price Stripe)
  quotaSeconds: number;
  priceUsd: number; // prix affiché / mois
}

/** Prix mensuels (affichage UI). */
export const PLAN_PRICE_USD: Record<Plan, number> = {
  free: 0,
  solo: 29,
  pro: 79,
  studio: 199,
};

function priceId(envKey: string): string | null {
  return process.env[envKey] ?? null;
}

/** Mapping plan → price_id Stripe (depuis env). */
export const BILLING_PLANS: Record<Plan, BillingPlan> = {
  free: {
    plan: "free",
    priceId: null,
    quotaSeconds: QUOTAS_SECONDS.free,
    priceUsd: 0,
  },
  solo: {
    plan: "solo",
    priceId: priceId("STRIPE_PRICE_ID_SOLO"),
    quotaSeconds: QUOTAS_SECONDS.solo,
    priceUsd: PLAN_PRICE_USD.solo,
  },
  pro: {
    plan: "pro",
    priceId: priceId("STRIPE_PRICE_ID_PRO"),
    quotaSeconds: QUOTAS_SECONDS.pro,
    priceUsd: PLAN_PRICE_USD.pro,
  },
  studio: {
    plan: "studio",
    priceId: priceId("STRIPE_PRICE_ID_STUDIO"),
    quotaSeconds: QUOTAS_SECONDS.studio,
    priceUsd: PLAN_PRICE_USD.studio,
  },
};

export const PAID_PLANS: Plan[] = ["solo", "pro", "studio"];

export function planFromPriceId(pid: string | null): Plan | null {
  if (!pid) return null;
  for (const plan of PAID_PLANS) {
    if (BILLING_PLANS[plan].priceId === pid) return plan;
  }
  return null;
}
