import Stripe from "stripe";
import { resolveStripeSetupPolicy } from "./stripe-script-policy.mjs";

const PRODUCTS = [
  {
    plan: "solo",
    name: "Solo",
    description: "8 minutes of clips/month, pro styles, no watermark",
    unitAmount: 2900,
  },
  {
    plan: "pro",
    name: "Pro",
    description: "30 minutes of clips/month, all styles, no watermark",
    unitAmount: 7900,
  },
  {
    plan: "studio",
    name: "Studio",
    description: "60 minutes of clips/month, everything unlocked",
    unitAmount: 19900,
  },
];

async function findOrCreateProduct(stripe, definition) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.data.find(
    (product) => product.metadata.clipsflow_plan === definition.plan,
  );
  if (existing) return existing;

  return stripe.products.create(
    {
      name: definition.name,
      description: definition.description,
      metadata: { clipsflow_plan: definition.plan },
    },
    { idempotencyKey: `clipsflow:test:product:${definition.plan}` },
  );
}

async function findOrCreatePrice(stripe, definition, productId) {
  const prices = await stripe.prices.list({
    active: true,
    product: productId,
    limit: 100,
  });
  const existing = prices.data.find(
    (price) =>
      price.currency === "usd" &&
      price.unit_amount === definition.unitAmount &&
      price.recurring?.interval === "month",
  );
  if (existing) return existing;

  return stripe.prices.create(
    {
      product: productId,
      unit_amount: definition.unitAmount,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { clipsflow_plan: definition.plan },
    },
    { idempotencyKey: `clipsflow:test:price:${definition.plan}` },
  );
}

async function main() {
  const policy = resolveStripeSetupPolicy({
    secretKey: process.env.STRIPE_SECRET_KEY,
    args: process.argv.slice(2),
  });

  if (!policy.apply) {
    console.log("DRY RUN — aucune mutation Stripe.");
    for (const product of PRODUCTS) {
      console.log(
        `${product.plan}: ${product.name}, USD ${(product.unitAmount / 100).toFixed(2)}/month`,
      );
    }
    console.log("Relancer avec --apply pour créer uniquement en mode test.");
    return;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-07-29.dahlia",
    typescript: true,
  });
  const priceIds = {};
  for (const definition of PRODUCTS) {
    const product = await findOrCreateProduct(stripe, definition);
    const price = await findOrCreatePrice(stripe, definition, product.id);
    priceIds[definition.plan] = price.id;
  }

  console.log("Produits/prix Stripe TEST prêts. Identifiants non secrets :");
  for (const [plan, priceId] of Object.entries(priceIds)) {
    console.log(`STRIPE_PRICE_ID_${plan.toUpperCase()}=${priceId}`);
  }
  console.log(
    "Crée le webhook test séparément dans Stripe Dashboard; ne copie jamais son secret dans le terminal ou le chat.",
  );
}

main().catch((error) => {
  const code = error instanceof Error ? error.message : "stripe_setup:failed";
  const safeCode = code.startsWith("stripe_setup:")
    ? code
    : "stripe_setup:failed";
  console.error(safeCode);
  process.exitCode = 1;
});
