# ClipsFlow P0 Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the validated P0 production security boundaries while preserving ClipsFlow's existing user flows and API contracts.

**Architecture:** Put lifecycle mutations and rate limits behind service-role-only Postgres RPCs, make Stripe processing ordered and idempotent, centralize trusted origins and outbound fetch validation, then upgrade vulnerable dependencies and neutralize unsafe operational scripts. Execute inline in the isolated `fix/p0-security-hardening` worktree with strict red-green-refactor cycles.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Vitest, Supabase/Postgres RLS, Stripe Billing, Node.js fetch/DNS, pnpm.

## Global Constraints

- Never print or pass secret values on a command line.
- Never apply DDL to a Supabase project whose reference does not match ClipsFlow.
- Keep Next.js on the patched 16.2 release line for this P0 batch.
- Preserve the `202`, `400`, `401`, `402`, `403`, `404`, `429`, and `500/503` route semantics already consumed by the UI.
- Free-plan watermark is mandatory and fail-closed.
- Every AI job endpoint has quota and distributed rate limiting.
- Use French Conventional Commit messages.

---

### Task 1: Patch vulnerable dependencies

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: existing package scripts and Next.js 16.2 application.
- Produces: patched dependency graph with no production high advisory.

- [ ] **Step 1: Record the failing security gate**

  Run `pnpm audit --prod --audit-level high` and retain the non-zero result showing Next `<16.2.11` and Sharp `<0.35.0`.

- [ ] **Step 2: Apply the narrow version updates**

  Run:

  ```powershell
  pnpm add next@16.2.11 sharp@0.35.3 react@19.2.8 react-dom@19.2.8 @sentry/nextjs@10.70.0 next-intl@4.13.6 @supabase/ssr@0.12.4 @supabase/supabase-js@2.112.3 stripe@22.5.0
  pnpm add -D eslint-config-next@16.2.11
  pnpm remove fluent-ffmpeg @types/fluent-ffmpeg
  pnpm remove shadcn
  pnpm add -D shadcn@4.18.0
  ```

- [ ] **Step 3: Verify the dependency gate**

  Run `pnpm audit --prod --audit-level high`, `pnpm typecheck`, and `pnpm build`.

- [ ] **Step 4: Commit**

  ```powershell
  git add package.json pnpm-lock.yaml
  git commit -m "fix(securite): corriger les dependances vulnerables"
  ```

### Task 2: Enforce database mutation boundaries

**Files:**

- Create: `supabase/migrations/20260816133249_p0_security_hardening.sql`
- Create: `src/lib/clips/submit-job.ts`
- Create: `src/lib/clips/submit-job.test.ts`
- Modify: `src/app/api/clips/jobs/route.ts`
- Modify: `src/app/api/clips/upload-init/route.ts`
- Modify: `src/app/api/cron/process-clips/route.ts`

**Interfaces:**

- Produces: `submitClipJob(admin, input): Promise<{ clipId: string; jobId: string; remaining: number }>`.
- Produces: RPC `clips_submit_job(...)` executable only by `service_role`.

- [ ] **Step 1: Write the failing submit-result tests**

  Cover a valid RPC row, `quota_exceeded`, and an unexpected PostgREST error.

  ```ts
  await expect(submitClipJob(client, validInput)).resolves.toEqual({
    clipId: "clip-1",
    jobId: "job-1",
    remaining: 30,
  });
  await expect(submitClipJob(quotaClient, validInput)).rejects.toMatchObject({
    code: "quota_exceeded",
  });
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  Run `pnpm vitest run src/lib/clips/submit-job.test.ts` and require failure because `submitClipJob` does not exist.

- [ ] **Step 3: Implement the migration and helper**

  The SQL must revoke authenticated INSERT/UPDATE on lifecycle tables, protect profile quota/billing fields, add `api_rate_limits`, and create `clips_submit_job` with `SECURITY DEFINER SET search_path = ''`, fully qualified names, and service-role-only EXECUTE.

- [ ] **Step 4: Route all server mutations through the admin/RPC boundary**

  `/api/clips/jobs` calls `submitClipJob`; upload-init uses the authenticated user ID but inserts through the admin client. Browser clients keep SELECT and terminal DELETE behavior only.

- [ ] **Step 5: Verify GREEN and static SQL invariants**

  Run the focused test plus a migration test that proves RPC grants exclude `PUBLIC`, `anon`, and `authenticated` and every protected table has RLS enabled.

- [ ] **Step 6: Commit**

  ```powershell
  git add supabase/migrations/20260816133249_p0_security_hardening.sql src/lib/clips src/app/api/clips src/app/api/cron
  git commit -m "fix(securite): verrouiller les mutations du pipeline"
  ```

### Task 3: Add distributed rate limiting

**Files:**

- Create: `src/lib/rate-limit-distributed.ts`
- Create: `src/lib/rate-limit-distributed.test.ts`
- Modify: `src/app/api/clips/jobs/route.ts`
- Modify: `src/app/api/clips/transcribe/route.ts`
- Modify: `src/app/api/clips/upload-init/route.ts`
- Modify: `src/app/api/billing/checkout/route.ts`
- Delete: `src/lib/rate-limit.ts`

**Interfaces:**

- Produces: `checkDistributedRateLimit(client, key, limit, windowSeconds)` returning `{ allowed, retryAfterSeconds }`.

- [ ] **Step 1: Write RED tests** for allowed, denied, malformed RPC response, and database failure.
- [ ] **Step 2: Run** `pnpm vitest run src/lib/rate-limit-distributed.test.ts` and verify the missing-module failure.
- [ ] **Step 3: Implement** the helper and return 503 on limiter failure, 429 with `Retry-After` on denial.
- [ ] **Step 4: Wire limits**: jobs `10/60s`, transcribe `30/60s`, upload-init `10/60s`, checkout `5/300s`.
- [ ] **Step 5: Run focused and route tests**, then commit with `fix(securite): distribuer la limitation de debit`.

### Task 4: Harden origins, OAuth, and Stripe billing

**Files:**

- Create: `src/lib/http/trusted-app-url.ts`
- Create: `src/lib/http/trusted-app-url.test.ts`
- Create: `src/lib/billing/webhook-state.ts`
- Create: `src/lib/billing/webhook-state.test.ts`
- Modify: `src/app/api/auth/google/route.ts`
- Modify: `src/app/api/auth/callback/route.ts`
- Modify: `src/app/api/billing/checkout/route.ts`
- Modify: `src/app/api/billing/portal/route.ts`
- Modify: `src/app/api/billing/webhook/route.ts`
- Modify: `supabase/migrations/20260816133249_p0_security_hardening.sql`

**Interfaces:**

- Produces: `getTrustedAppUrl(): URL` and `safeRelativePath(raw, fallback): string`.
- Produces: webhook event claim/complete/fail helpers and timestamp-guarded profile updates.

- [ ] **Step 1: Write RED tests** rejecting absolute/protocol-relative callbacks and production HTTP/missing origins.
- [ ] **Step 2: Implement trusted-origin helpers** and use them in OAuth, Checkout, and Portal.
- [ ] **Step 3: Write RED tests** proving processed duplicates are skipped, failed events retry, and stale timestamps cannot apply.
- [ ] **Step 4: Implement webhook state** with verified signatures, complete Stripe status coverage, price-ID plan mapping, and failure persistence.
- [ ] **Step 5: Add Checkout idempotency** using a required UUID `request_id` and stable customer key.
- [ ] **Step 6: Run focused tests and commit** with `fix(facturation): rendre stripe idempotent et ordonne`.

### Task 5: Close outbound-fetch and log-redaction boundaries

**Files:**

- Modify: `src/lib/security/validate-outbound-url.ts`
- Create: `src/lib/security/validate-outbound-url.test.ts`
- Modify: `src/lib/utils/safe-fetch.ts`
- Create: `src/lib/utils/safe-fetch.test.ts`
- Modify: `src/lib/clips/subtitle-burn-png-overlay.ts`
- Modify: `src/app/api/clips/jobs/route.ts`
- Modify: `src/lib/observability/sentry-scrubber.ts`
- Create: `src/lib/observability/sentry-scrubber.test.ts`

**Interfaces:**

- Produces: `assertPublicDns(url, lookup?)` and redirect-validating `safeFetch(input, init)`.

- [ ] **Step 1: Write RED tests** for private DNS, mixed public/private answers, internal redirect, credentials, nonstandard ports, and redirect loops.
- [ ] **Step 2: Implement URL/DNS/redirect enforcement** with manual redirects and the existing timeout semantics.
- [ ] **Step 3: Replace the raw PNG-overlay fetch** and enforce the same Supabase logo allowlist at API and worker boundaries.
- [ ] **Step 4: Write RED scrubber tests** for JWTs, Stripe/OpenAI keys, signed query strings, exception values, breadcrumb messages, and array preservation.
- [ ] **Step 5: Implement recursive redaction**, run focused tests, and commit with `fix(securite): fermer les sorties reseau et les journaux`.

### Task 6: Make watermarking fail closed

**Files:**

- Create: `src/lib/clips/watermark-policy.ts`
- Create: `src/lib/clips/watermark-policy.test.ts`
- Modify: `src/lib/clips/run-job.ts`

**Interfaces:**

- Produces: `applyPlanWatermark(plan, input, apply): Promise<Buffer>`.

- [ ] **Step 1: Write RED tests** proving free-plan failure throws `watermark_failed:` and paid plans do not call the renderer.
- [ ] **Step 2: Implement the minimal policy helper** and integrate it into `runRenderJob`.
- [ ] **Step 3: Run focused tests** and commit with `fix(revenus): imposer le watermark gratuit`.

### Task 7: Neutralize dangerous operations and stale docs

**Files:**

- Delete: `scripts/stripe_goto.py`
- Delete: `scripts/create_stripe_products.py`
- Create: `scripts/setup-stripe-test.mjs`
- Create: `src/lib/operations/stripe-script-policy.ts`
- Create: `src/lib/operations/stripe-script-policy.test.ts`
- Modify: `scripts/test-webhook-e2e.mjs`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/SECRETS.md`
- Modify: `docs/phase-1-smoke-test.md`

**Interfaces:**

- Produces: dry-run-first Stripe setup that accepts environment keys only and rejects non-test mode.

- [ ] **Step 1: Write RED policy tests** for live-key rejection and explicit `--apply` gating.
- [ ] **Step 2: Replace unsafe scripts** without printing keys or webhook secrets.
- [ ] **Step 3: Add E2E guards and `finally` cleanup** for test users.
- [ ] **Step 4: Align documentation** with ClipsFlow, current column names, safe secret injection, and rollback instructions.
- [ ] **Step 5: Run focused tests** and commit with `fix(operations): securiser les scripts et procedures`.

### Task 8: Full verification and handoff

**Files:**

- Modify only files required by failures attributable to Tasks 1-7.

- [ ] **Step 1: Run focused security tests** and confirm each exploit class no longer reproduces.
- [ ] **Step 2: Run repository gates**:

  ```powershell
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm build
  pnpm audit --prod --audit-level high
  git diff --check
  ```

- [ ] **Step 3: Run secret scan** without printing values and inspect `git status` plus the complete branch diff.
- [ ] **Step 4: Run Supabase advisors only on a verified matching project**; otherwise record the live-database verification as blocked and do not deploy.
- [ ] **Step 5: Prepare the ultra-mega correction prompt** from the final verified diff, remaining risks, deployment order, rollback, and acceptance gates.
