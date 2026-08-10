import type { ErrorEvent, Breadcrumb } from "@sentry/nextjs";

/**
 * PII scrubber — retire emails, contenus générés, prompts, stacks internes
 * avant d'envoyer à Sentry. Best-effort minimal (ClipsFlow P1).
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function scrubString(value: string): string {
  return value.replace(EMAIL_RE, "[email]");
}

function recursiveSanitize(obj: unknown): unknown {
  if (typeof obj === "string") return scrubString(obj);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lowerKey = k.toLowerCase();
      const sensitive = [
        "email",
        "prompt",
        "api_key",
        "token",
        "password",
        "authorization",
        "cookie",
      ].some((field) => lowerKey.includes(field));
      out[k] = sensitive ? "[redacted]" : recursiveSanitize(v);
    }
    return out;
  }
  return obj;
}

export function sentryBeforeSend(event: ErrorEvent): ErrorEvent | null {
  if (event.user?.email) {
    event.user.email = "[redacted]";
  }
  if (event.request) {
    event.request = recursiveSanitize(event.request) as typeof event.request;
  }
  if (event.contexts) {
    event.contexts = recursiveSanitize(event.contexts) as typeof event.contexts;
  }
  return event;
}

export function sentryBeforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.data) {
    breadcrumb.data = recursiveSanitize(breadcrumb.data) as typeof breadcrumb.data;
  }
  return breadcrumb;
}
