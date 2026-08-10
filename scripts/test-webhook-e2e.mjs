// test-webhook-e2e.mjs — valide que /api/billing/webhook met à jour profiles.plan
// après checkout.session.completed (mock Stripe, jamais d'appel réel).

import crypto from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing env: STRIPE_WEBHOOK_SECRET / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// 1. Crée un utilisateur de test via Supabase Admin
async function createTestUser() {
  const email = `test-${Date.now()}@example.com`;
  const password = "test-password-123";
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Test User" },
    }),
  });
  if (!res.ok) throw new Error(`create user failed: ${await res.text()}`);
  const user = await res.json();
  return { id: user.id, email };
}

// 2. Simule un webhook checkout.session.completed
async function fireWebhook(userId, plan) {
  const event = {
    id: `evt_test_${Date.now()}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${Date.now()}`,
        metadata: { user_id: userId, plan },
        customer: `cus_test_${Date.now()}`,
        subscription: `sub_test_${Date.now()}`,
      },
    },
  };
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${sig}`,
    },
    body: payload,
  });
  return res;
}

// 3. Vérifie le plan dans profiles
async function checkProfile(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,subscription_status,stripe_customer_id`,
    {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
    },
  );
  const rows = await res.json();
  return rows[0];
}

const { id: userId, email } = await createTestUser();
console.log(`✓ Test user créé: ${email}`);

const res = await fireWebhook(userId, "pro");
const body = await res.text();
console.log(`✓ Webhook /api/billing/webhook → HTTP ${res.status}: ${body}`);

const profile = await checkProfile(userId);
console.log("✓ Profile après webhook:", profile);

if (profile.plan === "pro" && profile.subscription_status === "active") {
  console.log("\n✅ PASS — webhook met à jour plan → pro + status active");
} else {
  console.log("\n❌ FAIL — plan attendu 'pro'/'active', obtenu:", profile);
  process.exit(1);
}
