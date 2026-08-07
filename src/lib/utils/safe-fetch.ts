// ============================================================================
// safeFetch — fetch with explicit AbortSignal timeout
// ============================================================================
// Default lambda timeout is 30 s, but `fetch()` to upstreams has NO timeout
// by default — a hanging upstream blocks until the lambda maxDuration then
// SIGKILLs without a clean error.
//
// This helper aborts the fetch after `timeoutMs`, throws a typed
// `FetchTimeoutError`, and frees the lambda slot immediately.
//
// Ported from VidiaFlow src/lib/utils/safe-fetch.ts (unchanged).
// ============================================================================

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Fetch timeout : ${url} did not respond within ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
  }
}

export interface SafeFetchInit extends RequestInit {
  /**
   * Hard timeout in milliseconds for the entire fetch (including response
   * body read time). Defaults to 30 000 ms.
   */
  timeoutMs?: number;
}

/**
 * Wrapped fetch with explicit AbortSignal timeout.
 *
 * @param input      Same as `fetch()` first arg (URL string, URL object,
 *                   or Request).
 * @param init       Same as `fetch()` second arg, plus `timeoutMs`. If the
 *                   caller already supplies `signal`, it is composed with
 *                   the timeout signal via `AbortSignal.any` (Node ≥20.3).
 * @returns          The fetch `Response` if the upstream responded in time.
 * @throws           `FetchTimeoutError` if the upstream did not respond
 *                   within `timeoutMs`. Other fetch errors propagate as-is.
 */
export async function safeFetch(
  input: RequestInfo | URL,
  init?: SafeFetchInit,
): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Compose user-provided signal with our timeout signal so an outer abort
  // still kills the fetch promptly.
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;

  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
