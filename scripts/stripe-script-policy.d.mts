export interface StripeSetupPolicyInput {
  secretKey: string | undefined;
  args: string[];
}

export interface StripeSetupPolicy {
  apply: boolean;
  mode: "test";
}

export function resolveStripeSetupPolicy(
  input: StripeSetupPolicyInput,
): StripeSetupPolicy;
