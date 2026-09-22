// ============================================================================
// ClipsFlow Clips — feature flag
// ============================================================================
// Reads `CLIPS_ENABLED`. Recognised formats :
//   "none"              → disabled everywhere (safe default in production)
//   "all"               → enabled for every locale + every user
//   "fr"                → enabled for the listed locales only
//   "fr,en"             → enabled for listed locales only
//   "user:<uuid>"       → enabled only for these user ids (dark launch)
//   "user:abc,user:def" → multiple user ids
//
// Anything ambiguous (mixed locale + user tokens, garbage) → returns
// `false`. Fail closed : a bad env var should never accidentally enable
// Clips before the founder is ready.
//
// Ported from VidiaFlow src/lib/clipflow/feature-flag.ts +
// src/lib/feature-flag.ts (the generic parser is inlined here — ClipsFlow
// has a single flag-gated surface, no need for the shared module).
// Adaptations :
//   - Env var CLIPFLOW_ENABLED → CLIPS_ENABLED
//   - Names parseClipflowFlag / isClipflowEnabledFor / isClipflowEnabled /
//     getClipflowEnabledLocales → Clips equivalents
//   - NEW : in dev (NODE_ENV !== 'production'), an UNSET / empty env var
//     defaults to "all" so local development needs zero configuration.
//     An explicitly-set value (including "none") is always respected.
// ============================================================================

export type ClipsFlag =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "locales"; locales: string[] }
  | { kind: "user"; userIds: string[] };

/**
 * Pure parser — accepts the raw env value, returns a discriminated union.
 * Exported separately from `isClipsEnabledFor` so tests can unit-test
 * parsing logic without touching `process.env`.
 *
 * Multi-user mode (clipflow semantics) : accepts `"user:a,user:b"`.
 * Locale tokens accept any `[A-Za-z-]+` string (no allowlist).
 */
export function parseClipsFlag(raw: string | undefined | null): ClipsFlag {
  if (raw == null) return { kind: "none" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "none" };
  if (trimmed === "none") return { kind: "none" };
  if (trimmed === "all") return { kind: "all" };

  // Tokenize on commas.
  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { kind: "none" };

  const allUser = tokens.every((t) => t.startsWith("user:"));
  const anyUser = tokens.some((t) => t.startsWith("user:"));

  // Mixed locale + user tokens → ambiguous, fail closed.
  if (anyUser && !allUser) return { kind: "none" };

  if (allUser) {
    const userIds = tokens
      .map((t) => t.slice("user:".length).trim())
      .filter((id) => id.length > 0);
    if (userIds.length === 0) return { kind: "none" };
    return { kind: "user", userIds };
  }

  // Locale list — each token must be [A-Za-z-]+ only (no colons, no spaces).
  const allLocaleish = tokens.every((t) => /^[A-Za-z-]+$/.test(t));
  if (!allLocaleish) return { kind: "none" };
  return { kind: "locales", locales: tokens };
}

/**
 * Pure check on an already-parsed flag.
 */
export function isClipsFlagEnabled(
  flag: ClipsFlag,
  user: { locale?: string; userId?: string },
): boolean {
  switch (flag.kind) {
    case "none":
      return false;
    case "all":
      return true;
    case "locales":
      return user.locale != null && flag.locales.includes(user.locale);
    case "user":
      return user.userId != null && flag.userIds.includes(user.userId);
  }
}

/**
 * Pure check — caller passes the env value explicitly. Route handlers read
 * `process.env.CLIPS_ENABLED` and pass it here ; tests pass synthetic
 * values. Fail-closed on unset values (the dev default lives only in the
 * env-reading wrappers below so this stays deterministic for tests).
 */
export function isClipsEnabledFor(input: {
  flagValue: string | undefined | null;
  locale?: string;
  userId?: string;
}): boolean {
  return isClipsFlagEnabled(parseClipsFlag(input.flagValue), {
    locale: input.locale,
    userId: input.userId,
  });
}

/**
 * Resolve the effective raw flag value from the environment.
 * In dev (NODE_ENV !== 'production'), an unset / empty `CLIPS_ENABLED`
 * defaults to "all" — zero-config local development. Production keeps the
 * fail-closed "none" default.
 */
function effectiveRawFlag(): string | undefined {
  const raw = process.env.CLIPS_ENABLED;
  if (
    (raw == null || raw.trim().length === 0) &&
    process.env.NODE_ENV !== "production"
  ) {
    return "all";
  }
  return raw;
}

/**
 * Convenience wrapper that reads from `process.env` directly. Use from
 * route handlers ; tests should prefer `isClipsEnabledFor`.
 */
export function isClipsEnabled(input: {
  locale?: string;
  userId?: string;
}): boolean {
  return isClipsEnabledFor({
    flagValue: effectiveRawFlag(),
    locale: input.locale,
    userId: input.userId,
  });
}

/**
 * Separate operational gate for render capacity.  It is intentionally
 * independent from the product rollout flag above: when the Railway worker
 * is paused for budget or maintenance, the API must not reserve a user's
 * quota for work that cannot start.  Local development remains convenient;
 * production is fail-closed until the worker has passed staging validation.
 */
export function isClipsWorkerEnabled(
  raw = process.env.CLIPS_WORKER_ENABLED,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  if (raw == null || raw.trim().length === 0) {
    return nodeEnv !== "production";
  }
  return raw.trim().toLowerCase() === "true" || raw.trim() === "1";
}

/**
 * Diagnostic helper — returns the list of locales currently enabled.
 *
 * Semantics :
 *   - "none"    → []
 *   - "all"     → ["*"]  (sentinel meaning all)
 *   - "fr,en"   → ["fr","en"]
 *   - "user:x"  → []    (user-scoped, no locales)
 *
 * Pure ; no side effects beyond the `process.env` read.
 */
export function getClipsEnabledLocales(): string[] {
  const flag = parseClipsFlag(effectiveRawFlag());
  switch (flag.kind) {
    case "none":
      return [];
    case "all":
      return ["*"];
    case "locales":
      return [...flag.locales];
    case "user":
      return [];
  }
}
