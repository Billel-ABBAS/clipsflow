# ClipsFlow P0 Security Hardening Design

**Date:** 2026-08-16

**Status:** Approved for inline implementation by the repository owner.

## Goal

Close the production-critical authorization, billing, dependency, outbound-network,
quota, and secret-handling weaknesses found during the 2026-08-15 audit without
changing ClipsFlow's clips-only product scope.

## Non-negotiable invariants

- Authenticated browser clients may read only their own business rows.
- Browser clients may never create or mutate pipeline lifecycle rows directly.
- Only server-side, authenticated route handlers may submit render work.
- Quota reservation, clip creation, and queue insertion are one Postgres transaction.
- Free-plan output is never published without the server-side watermark.
- Stripe events are signature-verified, idempotent, and protected against stale events.
- All AI and billing entry points use a shared, multi-instance rate limit.
- Outbound media fetches validate every redirect and reject private DNS results.
- Secrets are consumed from process environment only and never printed or passed as CLI arguments.
- Unknown or missing production configuration fails closed.

## Selected architecture

### 1. Database-owned mutation boundary

Migration `20260816133249_p0_security_hardening.sql` removes authenticated INSERT/UPDATE
policies and privileges from `episodes`, `clips`, and `jobs`. `profiles` keeps
owner SELECT plus column-scoped UPDATE only for `email`, `full_name`, and
`locale`; a trigger protects billing and quota columns as defense in depth.

The service-role-only function `clips_submit_job(...)` validates episode
ownership, resolves the plan quota, reserves seconds, inserts the clip, and
inserts the render job in one transaction. Any failure rolls the whole unit
back. Its EXECUTE privilege is revoked from `PUBLIC`, `anon`, and
`authenticated` before being granted to `service_role`.

### 2. Distributed rate limiting

`public.api_rate_limits` is RLS-enabled with no browser policies. The
service-role-only RPC `consume_api_rate_limit(...)` implements a fixed window
counter. Application helper `checkDistributedRateLimit()` converts its record
into `{ allowed, retryAfterSeconds }` and fails closed on database errors.

### 3. Stripe event state machine

`public.stripe_webhook_events` records event IDs, processing status, attempts,
errors, and completion timestamps. Duplicate processed events return 200
without reapplying mutations. Failed events remain retryable.

`profiles.stripe_event_created_at` stores the newest Stripe event timestamp
applied to the profile. Older events cannot regress plan or subscription state.
The subscription status constraint accepts every current Stripe status:
`incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`,
`canceled`, `unpaid`, and `paused`, plus local sentinel `none`.

Checkout uses a validated request UUID as Stripe idempotency key. Customer
creation uses a stable per-user idempotency key and fails if the customer ID
cannot be persisted.

### 4. Trusted origins and OAuth redirects

`getTrustedAppUrl()` is the sole application-origin source. Production requires
an absolute HTTPS `NEXT_PUBLIC_APP_URL`; development may use localhost HTTP.
OAuth callback destinations accept only same-origin paths beginning with a
single `/` and reject protocol-relative or absolute values.

### 5. Outbound fetch boundary

The synchronous URL validator rejects credentials, non-HTTPS schemes,
nonstandard ports, private literals, and hosts outside an optional allowlist.
The asynchronous guard resolves all A/AAAA records and rejects any private,
loopback, link-local, documentation, multicast, or reserved result.

`safeFetch()` uses `redirect: "manual"`, validates DNS immediately before each
request, validates each `Location`, limits redirect depth, and keeps the existing
timeout contract. Logo URLs are restricted to ClipsFlow's Supabase Storage
allowlist at both submission and render boundaries.

### 6. Revenue protection and observability

Watermark failure on a free plan throws `watermark_failed:` and follows the
normal terminal failure/refund path. Paid plans remain unchanged.

The Sentry scrubber preserves arrays while recursively sanitizing values. It
redacts credentials, API-key-shaped strings, JWTs, URL credentials/query
strings, exception values, log entries, breadcrumb messages, request data, and
contexts before transport.

### 7. Dependency and operations hardening

- Upgrade Next.js to the patched 16.2 line and align `eslint-config-next`.
- Upgrade Sharp to a fixed 0.35 release.
- Upgrade safe patch/minor runtime dependencies needed to remove known high advisories.
- Remove unused/deprecated `fluent-ffmpeg` packages if source search confirms no import.
- Keep the `shadcn` CLI/build package out of the production dependency set.
- Remove the browser script that scrapes Stripe API-key pages.
- Replace live-by-default Stripe provisioning with an explicit test-mode,
  dry-run-first Node script.
- Make webhook E2E mutation opt-in, reject production, and always clean up.

## Compatibility

- Existing authenticated reads and Realtime subscriptions continue to use RLS.
- Existing upload, URL-source, gallery, duplicate, billing checkout, portal,
  webhook, and cron response shapes remain stable unless a documented security
  error is returned.
- The clips-only product scope, locales, plans, and quota amounts do not change.
- No migration is applied to the currently connected Supabase MCP project,
  because its project reference does not match ClipsFlow's configured URL.

## Verification gates

1. Every behavioral change begins with a failing focused test.
2. Migration SQL is parsed/linted and, when a matching local or remote test
   database is available, exercised as `authenticated` and `service_role`.
3. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.
4. `pnpm audit --prod` reports no remaining high-severity advisory.
5. A secret-pattern scan reports no tracked secret value.
6. `git diff --check` and a change-aware security reread pass.

## Explicit deployment boundary

This implementation may write repository files and lockfiles. It must not apply
DDL, rotate keys, create Stripe products, alter Stripe live mode, deploy to
Vercel, or push Git commits to a remote without a separately verified target and
an explicit deployment instruction.
