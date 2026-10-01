-- Explicit Data API grants for projects where automatic table exposure is off.
--
-- RLS remains the row-level boundary.  `anon` receives no access.  Browser
-- clients can only read rows that their existing RLS policies permit, and
-- profile edits remain limited to the three presentation fields granted by the
-- P0 hardening migration.  All lifecycle mutations stay on trusted server
-- routes and the Railway worker, which use `service_role`.

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

-- Authenticated browser / SSR reads, fenced by the existing own-row policies.
GRANT SELECT ON TABLE
  public.profiles,
  public.episodes,
  public.clips,
  public.jobs
TO authenticated;

-- The P0 migration deliberately restricts user profile updates to identity
-- presentation fields; preserve that narrow column-level grant here.
GRANT UPDATE (email, full_name, locale)
ON TABLE public.profiles
TO authenticated;

-- Trusted API routes and the Railway worker operate with service_role.  Do
-- not grant lifecycle-table writes to browser roles.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.profiles,
  public.episodes,
  public.clips,
  public.jobs,
  public.api_rate_limits,
  public.stripe_webhook_events
TO service_role;
