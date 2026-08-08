// ClipsFlow — client Stripe serveur (SERVER ONLY, jamais importé côté client)

import Stripe from "stripe";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  cached = new Stripe(key, {
    apiVersion: "2026-07-29.dahlia",
    typescript: true,
  });
  return cached;
}
