// ============================================================================
// ClipsFlow Shorts — browser submission idempotency lifecycle
// ============================================================================

export type ShortsProjectIdempotencyIntent = Readonly<{
  fingerprint: string;
  key: string;
}>;

export type ShortsProjectIdempotencyStatus =
  | "draft"
  | "queued"
  | "transcribing"
  | "analyzing"
  | "ready"
  | "failed";

/** Reuse a key only while the outcome of that same submission is unresolved. */
export function resolveShortsProjectIdempotencyIntent(
  current: ShortsProjectIdempotencyIntent | null,
  fingerprint: string,
  createKey: () => string | null,
): ShortsProjectIdempotencyIntent | null {
  if (current?.fingerprint === fingerprint) return current;
  const key = createKey();
  return key ? { fingerprint, key } : null;
}

/** A terminal job must not make the next deliberate retry a duplicate no-op. */
export function releaseShortsProjectIdempotencyIntent(
  current: ShortsProjectIdempotencyIntent | null,
  status: ShortsProjectIdempotencyStatus,
): ShortsProjectIdempotencyIntent | null {
  return status === "ready" || status === "failed" ? null : current;
}
