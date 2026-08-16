// Local-only destructive smoke test for the signed Stripe webhook path.
// Requires explicit --apply and always deletes the temporary auth user.

import crypto from "node:crypto";

const args = process.argv.slice(2);
if (!args.includes("--apply") || args.some((arg) => arg !== "--apply")) {
  console.error("webhook_e2e:explicit_apply_required");
  process.exit(1);
}

let BASE;
let SUPABASE_URL;
try {
  BASE = new URL(process.env.BASE_URL ?? "http://127.0.0.1:3000");
  SUPABASE_URL = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
} catch {
  console.error("webhook_e2e:local_targets_only");
  process.exit(1);
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (
  !LOCAL_HOSTS.has(BASE.hostname) ||
  !LOCAL_HOSTS.has(SUPABASE_URL.hostname) ||
  process.env.ALLOW_LOCAL_MUTATION !== "1"
) {
  console.error("webhook_e2e:local_targets_only");
  process.exit(1);
}

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PRO_PRICE_ID = process.env.STRIPE_PRICE_ID_PRO;
if (!WEBHOOK_SECRET || !SERVICE_ROLE || !PRO_PRICE_ID) {
  console.error("webhook_e2e:missing_required_environment");
  process.exit(1);
}

async function createTestUser() {
  const response = await fetch(new URL("/auth/v1/admin/users", SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: `webhook-e2e-${crypto.randomUUID()}@example.invalid`,
      password: crypto.randomBytes(32).toString("base64url"),
      email_confirm: true,
      user_metadata: { full_name: "Webhook E2E" },
    }),
  });
  if (!response.ok) throw new Error("webhook_e2e:create_user_failed");
  const user = await response.json();
  return user.id;
}

async function deleteTestUser(userId) {
  const response = await fetch(
    new URL(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, SUPABASE_URL),
    {
      method: "DELETE",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
    },
  );
  if (!response.ok) throw new Error("webhook_e2e:cleanup_failed");
}

async function fireWebhook(userId) {
  const now = Math.floor(Date.now() / 1000);
  const event = {
    id: `evt_test_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "event",
    created: now,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: `sub_test_${crypto.randomUUID().replaceAll("-", "")}`,
        object: "subscription",
        customer: `cus_test_${crypto.randomUUID().replaceAll("-", "")}`,
        status: "active",
        metadata: { user_id: userId },
        items: { data: [{ price: { id: PRO_PRICE_ID } }] },
      },
    },
  };
  const payload = JSON.stringify(event);
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${now}.${payload}`)
    .digest("hex");
  return fetch(new URL("/api/billing/webhook", BASE), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": `t=${now},v1=${signature}`,
    },
    body: payload,
  });
}

async function readProfile(userId) {
  const url = new URL("/rest/v1/profiles", SUPABASE_URL);
  url.searchParams.set("id", `eq.${userId}`);
  url.searchParams.set("select", "plan,subscription_status");
  const response = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  });
  if (!response.ok) throw new Error("webhook_e2e:profile_read_failed");
  return (await response.json())[0];
}

let userId;
try {
  userId = await createTestUser();
  const response = await fireWebhook(userId);
  if (!response.ok) throw new Error("webhook_e2e:webhook_failed");
  const profile = await readProfile(userId);
  if (profile?.plan !== "pro" || profile?.subscription_status !== "active") {
    throw new Error("webhook_e2e:assertion_failed");
  }
  console.log(
    "PASS — webhook signé et état Stripe ordonné sur Supabase local.",
  );
} catch (error) {
  const message =
    error instanceof Error && error.message.startsWith("webhook_e2e:")
      ? error.message
      : "webhook_e2e:failed";
  console.error(message);
  process.exitCode = 1;
} finally {
  if (userId) {
    try {
      await deleteTestUser(userId);
    } catch {
      console.error("webhook_e2e:cleanup_failed");
      process.exitCode = 1;
    }
  }
}
