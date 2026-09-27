export function resolveStripeSetupPolicy({ secretKey, args }) {
  const unknown = args.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) throw new Error("stripe_setup:unknown_argument");

  const apply = args.includes("--apply");
  if (!apply && !secretKey) return { apply: false, mode: "test" };
  if (!secretKey) throw new Error("stripe_setup:key_missing");
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("stripe_setup:test_key_required");
  }

  return { apply, mode: "test" };
}
