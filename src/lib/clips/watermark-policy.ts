const PAID_PLANS = new Set(["solo", "pro", "studio"]);

/** Enforce the revenue watermark for free and unknown plan values. */
export async function applyPlanWatermark(
  plan: string,
  input: Buffer,
  apply: (buffer: Buffer) => Promise<Buffer>,
): Promise<Buffer> {
  if (PAID_PLANS.has(plan)) return input;

  try {
    return await apply(input);
  } catch (cause) {
    const error = new Error(
      "watermark_failed: mandatory free-plan watermark could not be applied",
    );
    error.cause = cause;
    throw error;
  }
}
