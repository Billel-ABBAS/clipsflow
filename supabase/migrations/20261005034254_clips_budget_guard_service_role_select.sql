-- The admin dashboard reads this operational singleton through the trusted
-- service-role client. Render admission uses SECURITY DEFINER RPCs, so the
-- client does not need direct mutation rights. Explicit grants keep this
-- working when Supabase stops exposing new public tables by default.
REVOKE ALL ON TABLE public.clips_budget_guard
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.clips_budget_guard TO service_role;
