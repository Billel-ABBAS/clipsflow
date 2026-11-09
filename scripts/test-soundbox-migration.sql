\set ON_ERROR_STOP on
BEGIN;
-- Disposable CI database only. Never run this fixture against Supabase.
CREATE ROLE soundbox_migration_test_client NOLOGIN;
CREATE TABLE public.shorts_audio_assets (
  id integer PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('elevenlabs', 'licensed_catalog'))
);
ALTER TABLE public.shorts_audio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_audio_assets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.shorts_audio_assets FROM PUBLIC;
INSERT INTO public.shorts_audio_assets VALUES (1, 'elevenlabs'), (2, 'licensed_catalog');
\ir ../supabase/migrations/20261109130000_allow_soundbox_shorts_audio.sql
-- The existing migration must be safe to repeat.
\ir ../supabase/migrations/20261109130000_allow_soundbox_shorts_audio.sql
INSERT INTO public.shorts_audio_assets VALUES (3, 'soundbox');
DO $$
BEGIN
  IF (SELECT count(*) FROM public.shorts_audio_assets) <> 3 THEN
    RAISE EXCEPTION 'historical_rows_not_preserved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shorts_audio_assets WHERE id=1 AND provider='elevenlabs') THEN
    RAISE EXCEPTION 'legacy_provider_changed';
  END IF;
  BEGIN
    INSERT INTO public.shorts_audio_assets VALUES (4, 'untrusted_provider');
    RAISE EXCEPTION 'invalid_provider_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.shorts_audio_assets'::regclass) THEN
    RAISE EXCEPTION 'rls_changed';
  END IF;
  IF has_table_privilege('soundbox_migration_test_client', 'public.shorts_audio_assets', 'SELECT')
     OR has_table_privilege('soundbox_migration_test_client', 'public.shorts_audio_assets', 'INSERT') THEN
    RAISE EXCEPTION 'unexpected_privilege_granted';
  END IF;
END $$;
SELECT 'PASS: provider allowlist, repeatability, legacy rows, RLS and grants' AS result;
ROLLBACK;
