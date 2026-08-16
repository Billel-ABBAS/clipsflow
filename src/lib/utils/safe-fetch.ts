import {
  OutboundUrlError,
  assertPublicDns,
  validateOutboundUrl,
  type DnsLookup,
} from "@/lib/security/validate-outbound-url";

export class FetchTimeoutError extends Error {
  constructor(url: URL, timeoutMs: number) {
    super(`Fetch timeout for ${url.origin} after ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
  }
}

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SafeFetchInit extends RequestInit {
  timeoutMs?: number;
  maxRedirects?: number;
  allowedHosts?: string[];
  /** Injectable seams used by deterministic security tests. */
  lookup?: DnsLookup;
  fetchImpl?: FetchImplementation;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function inputUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

/**
 * GET/HEAD fetch with an overall header timeout and SSRF checks before every
 * request in the redirect chain. Response bodies remain caller-owned.
 */
export async function safeFetch(
  input: RequestInfo | URL,
  init: SafeFetchInit = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    maxRedirects = 5,
    allowedHosts,
    lookup,
    fetchImpl = fetch,
    ...requestInit
  } = init;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 10
  ) {
    throw new OutboundUrlError("Invalid safe fetch limits");
  }

  const inheritedMethod = input instanceof Request ? input.method : undefined;
  const method = (requestInit.method ?? inheritedMethod ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new OutboundUrlError("safeFetch only permits GET and HEAD");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = requestInit.signal
    ? AbortSignal.any([requestInit.signal, controller.signal])
    : controller.signal;
  let current = inputUrl(input);

  try {
    for (let redirects = 0; ; redirects++) {
      current = validateOutboundUrl(current.href, { allowedHosts });
      await assertPublicDns(current, lookup);

      const response = await fetchImpl(current, {
        ...requestInit,
        method,
        redirect: "manual",
        signal,
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects >= maxRedirects) {
        await response.body?.cancel().catch(() => undefined);
        throw new OutboundUrlError("Too many outbound redirects");
      }

      const next = new URL(location, current);
      await response.body?.cancel().catch(() => undefined);
      current = next;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new FetchTimeoutError(current, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
