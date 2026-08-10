import * as Sentry from "@sentry/nextjs";
import {
  sentryBeforeSend,
  sentryBeforeBreadcrumb,
} from "@/lib/observability/sentry-scrubber";

/**
 * Edge-runtime Sentry init. Runs inside middleware + route handlers
 * with `export const runtime = "edge"`. Shares config with the Node init.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const envName = process.env.VERCEL_ENV || "development";
const isProd = envName === "production";

if (dsn) {
  Sentry.init({
    dsn,
    environment: envName,
    tracesSampleRate: isProd ? 0.1 : 1.0,
    sampleRate: isProd ? 0.5 : 1.0,
    ignoreErrors: [
      "AbortError",
      "NetworkError",
      "Failed to fetch",
      "fetch failed",
      "ECONNRESET",
      "ETIMEDOUT",
      "socket hang up",
      "NEXT_NOT_FOUND",
    ],
    beforeSend: sentryBeforeSend,
    beforeBreadcrumb: sentryBeforeBreadcrumb,
  });
}
