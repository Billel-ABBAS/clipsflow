-- The production canary and other trusted server-side diagnostics need to
-- verify the application render budget before creating a job. Keep this
-- operational table closed to browser roles and grant the server role only
-- read access; budget writes remain an operator-only database action.
REVOKE ALL PRIVILEGES ON TABLE public.clips_budget_guard
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.clips_budget_guard TO service_role;
