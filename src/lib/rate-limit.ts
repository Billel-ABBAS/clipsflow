// ClipsFlow — rate limit in-memory (token bucket simple)
// Suffisant pour le MVP — si on déploie en scale, switcher à Upstash.

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

const WINDOW_MS = 60_000; // 1 minute

export function checkRateLimit(
  key: string,
  limit: number,
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || now > existing.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }

  if (existing.count < limit) {
    existing.count++;
    return { allowed: true };
  }

  return { allowed: false, retryAfterMs: existing.resetAt - now };
}
