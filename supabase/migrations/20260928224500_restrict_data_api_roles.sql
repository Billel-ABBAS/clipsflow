-- Restrict the Data API to the public surface explicitly supported by
-- ClipsFlow. Earlier schema migrations left inherited table privileges in
-- place; RLS stopped data disclosure, but anon/authenticated could still
-- invoke SQL operations that the server is meant to own.
--
-- This is intentionally backwards-compatible with the app: browser clients
-- keep own-row reads and the three cosmetic profile fields; all lifecycle and
-- billing writes remain server/service_role only.

REVOKE ALL PRIVILEGES ON TABLE
  public.profiles,
  public.episodes,
  public.clips,
  public.jobs,
  public.api_rate_limits,
  public.stripe_webhook_events
FROM anon, authenticated;

-- The browser must never use anon to reach application tables. Authenticated
-- users only need read access to their own RLS-filtered rows.
GRANT SELECT ON TABLE
  public.profiles,
  public.episodes,
  public.clips,
  public.jobs
TO authenticated;

-- Preserve the P0 presentation-only profile edit boundary at the privilege
-- level, in addition to its RLS policy and sensitive-field trigger.
GRANT UPDATE (email, full_name, locale)
ON TABLE public.profiles
TO authenticated;

-- Service role is the only principal used by trusted Next.js routes, Stripe
-- handlers and the Railway worker. Keep the grant explicit so a future
-- migration cannot depend on inherited defaults.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.profiles,
  public.episodes,
  public.clips,
  public.jobs,
  public.api_rate_limits,
  public.stripe_webhook_events
TO service_role;

-- Move own-row read/edit policies away from PUBLIC. The role restriction is
-- defense in depth: anon has no table grant, and authenticated still needs
-- the ownership predicates already present in these policies.
ALTER POLICY "profiles_select_own" ON public.profiles TO authenticated;
ALTER POLICY "profiles_update_own_nonsensitive" ON public.profiles TO authenticated;
ALTER POLICY "episodes_select_own" ON public.episodes TO authenticated;
ALTER POLICY "clips_select_own" ON public.clips TO authenticated;
ALTER POLICY "jobs_select_own" ON public.jobs TO authenticated;

-- Direct deletion is not a public API. Jobs and artifacts are finalized by
-- trusted server-side paths so quota refunding and worker leases stay atomic.
DROP POLICY IF EXISTS "episodes_delete_own" ON public.episodes;
DROP POLICY IF EXISTS "clips_delete_own" ON public.clips;
