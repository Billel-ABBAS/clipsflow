-- Trigger functions do not need to be callable through the Data API.
-- Keep their references fully qualified and their search path immutable.
ALTER FUNCTION public.handle_new_user() SET search_path = '';
ALTER FUNCTION public.set_updated_at() SET search_path = '';

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
