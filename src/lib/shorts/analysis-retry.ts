type ErrorDetails = Record<string, unknown>;

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TRANSIENT_ERROR_NAMES = new Set([
  "AbortError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "FetchTimeoutError",
  "TimeoutError",
]);
const NON_RETRYABLE_PROVIDER_CODES = new Set([
  "billing_not_active",
  "insufficient_quota",
  "organization_usage_limit",
]);

function asDetails(value: unknown): ErrorDetails | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ErrorDetails)
    : null;
}

function readStatus(details: ErrorDetails): number | null {
  for (const key of ["status", "statusCode"] as const) {
    const value = details[key];
    const status =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{3}$/u.test(value)
          ? Number(value)
          : null;
    if (status !== null && Number.isInteger(status)) return status;
  }
  return null;
}

function hasNonRetryableQuotaCode(details: ErrorDetails): boolean {
  const nested = asDetails(details.error);
  const codes = [details.code, details.type, nested?.code, nested?.type].filter(
    (value): value is string => typeof value === "string",
  );
  const messages = [details.message, nested?.message].filter(
    (value): value is string => typeof value === "string",
  );
  return (
    codes.some((code) =>
      NON_RETRYABLE_PROVIDER_CODES.has(code.toLowerCase()),
    ) ||
    messages.some((message) =>
      /insufficient[_ ]quota|billing_not_active/iu.test(message),
    )
  );
}

/** Classify only upstream transport/rate/server failures, never arbitrary job errors. */
export function isTransientAnalysisUpstreamError(error: unknown): boolean {
  const details = asDetails(error);
  if (!details || hasNonRetryableQuotaCode(details)) return false;

  const status = readStatus(details);
  if (status !== null) {
    return (
      status === 0 ||
      TRANSIENT_HTTP_STATUSES.has(status) ||
      (status >= 500 && status <= 599)
    );
  }

  const name = typeof details.name === "string" ? details.name : "";
  const code =
    typeof details.code === "string" ? details.code.toUpperCase() : "";
  if (TRANSIENT_ERROR_NAMES.has(name) || TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }

  if (error instanceof TypeError) {
    return /fetch failed|network|socket|timeout/iu.test(error.message);
  }

  const message = typeof details.message === "string" ? details.message : "";
  return (
    message === "analysis_request_timeout" ||
    message === "analysis_fetch_timeout"
  );
}

export class RetryableShortsAnalysisError extends Error {
  readonly retryable = true;

  constructor(
    public readonly code:
      | "source_resolve_transient"
      | "source_download_transient"
      | "analysis_provider_transient",
  ) {
    super(code);
    this.name = "RetryableShortsAnalysisError";
  }
}
