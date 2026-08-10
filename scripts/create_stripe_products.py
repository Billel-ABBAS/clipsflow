# Crée les 3 produits + prix dans Stripe (mode LIVE)
# et récupère les price_id + webhook secret

import stripe
import sys

STRIPE_SECRET_KEY = sys.argv[1] if len(sys.argv) > 1 else None
if not STRIPE_SECRET_KEY:
    print("Usage: python create_stripe_products.py <sk_live_...>")
    sys.exit(1)

stripe.api_key = STRIPE_SECRET_KEY

# ── 1. Produits + Prix ──────────────────────────────────────────────────────
PRODUCTS = [
    {
        "key": "solo",
        "name": "Solo",
        "desc": "8 minutes of clips/month, pro styles, no watermark",
        "price": 2900,  # $29.00
    },
    {
        "key": "pro",
        "name": "Pro",
        "desc": "30 minutes of clips/month, all styles, no watermark",
        "price": 7900,  # $79.00
    },
    {
        "key": "studio",
        "name": "Studio",
        "desc": "60 minutes of clips/month, everything unlocked",
        "price": 19900,  # $199.00
    },
]

price_ids = {}
for p in PRODUCTS:
    # Crée le produit
    prod = stripe.Product.create(
        name=p["name"],
        description=p["desc"],
        type="service",
    )
    print(f"[{p['key']}] Product: {prod.id}")

    # Crée le prix récurrent
    price = stripe.Price.create(
        product=prod.id,
        unit_amount=p["price"],
        currency="usd",
        recurring={"interval": "month"},
    )
    print(f"[{p['key']}] Price: {price.id}")
    price_ids[p["key"]] = price.id

# ── 2. Webhook endpoint ─────────────────────────────────────────────────────
WEBHOOK_URL = "https://clipsflow-liart.vercel.app/api/billing/webhook"

try:
    wh = stripe.WebhookEndpoint.create(
        url=WEBHOOK_URL,
        enabled_events=[
            "checkout.session.completed",
            "customer.subscription.updated",
            "customer.subscription.deleted",
            "invoice.payment_failed",
        ],
    )
    print(f"\nWebhook: {wh.id}")
    print(f"Signing secret: {wh.secret}")
    webhook_secret = wh.secret
except Exception as e:
    print(f"\nWebhook error: {e}")
    webhook_secret = None

# ── 3. Affiche le résultat ───────────────────────────────────────────────────
print("\n" + "=" * 50)
print("VALEURS À COPIER DANS .env.local :")
print("=" * 50)
for k, v in price_ids.items():
    print(f"STRIPE_PRICE_ID_{k.upper()}={v}")
if webhook_secret:
    print(f"STRIPE_WEBHOOK_SECRET={webhook_secret}")
