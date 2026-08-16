import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const PROVIDER_KEY_RE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,}|rk_(?:live|test)_[A-Za-z0-9_-]{8,}|pk_(?:live|test)_[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,})\b/g;
const QUERY_SECRET_RE =
  /\b(?:access_token|refresh_token|token|signature|x-amz-signature|api_key|apikey|key)=([^&\s]+)/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const SENSITIVE_KEY_RE =
  /(?:^|[_-])(email|prompt|api[_-]?key|token|secret|password|authorization|cookie|credential|session)(?:$|[_-])/i;

function scrubUrl(raw: string): string {
  const trailing = raw.match(/[),.;!?]+$/)?.[0] ?? "";
  const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
  try {
    const url = new URL(candidate);
    const queryMarker = url.search ? "?[redacted]" : "";
    const hashMarker = url.hash ? "#[redacted]" : "";
    return `${url.origin}${url.pathname}${queryMarker}${hashMarker}${trailing}`;
  } catch {
    return "[redacted-url]";
  }
}

function scrubString(value: string): string {
  return value
    .replace(URL_RE, scrubUrl)
    .replace(EMAIL_RE, "[email]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(PROVIDER_KEY_RE, "[redacted-key]")
    .replace(QUERY_SECRET_RE, (match) => {
      const separator = match.indexOf("=");
      return `${match.slice(0, separator)}=[redacted]`;
    });
}

function recursiveSanitize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => recursiveSanitize(entry, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_RE.test(key)
      ? "[redacted]"
      : recursiveSanitize(nested, seen);
  }
  return output;
}

export function sentryBeforeSend(event: ErrorEvent): ErrorEvent | null {
  return recursiveSanitize(event) as ErrorEvent;
}

export function sentryBeforeBreadcrumb(
  breadcrumb: Breadcrumb,
): Breadcrumb | null {
  return recursiveSanitize(breadcrumb) as Breadcrumb;
}
