\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;

SELECT plan(18);

SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_catalog.pg_class
   WHERE oid = 'public.shorts_projects'::regclass),
  'Shorts projects enforce row-level security'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_catalog.pg_class
   WHERE oid = 'public.shorts_candidates'::regclass),
  'Shorts candidates enforce row-level security'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_catalog.pg_class
   WHERE oid = 'public.shorts_audio_assets'::regclass),
  'Shorts audio assets enforce row-level security'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_catalog.pg_class
   WHERE oid = 'public.shorts_analysis_jobs'::regclass),
  'Shorts analysis jobs enforce row-level security'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_catalog.pg_class
   WHERE oid = 'public.youtube_connections'::regclass),
  'YouTube connections enforce row-level security'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_catalog.pg_class
   WHERE oid = 'public.shorts_publications'::regclass),
  'Shorts publications enforce row-level security'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM storage.buckets
    WHERE id = 'clip-sources'
      AND file_size_limit = 8589934592
      AND public IS false
  ),
  'Long-form source bucket is private and capped at 8 GiB'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.shorts_projects', 'SELECT'),
  'authenticated users cannot bypass the Shorts service boundary'
);
SELECT ok(
  has_table_privilege('service_role', 'public.shorts_projects', 'SELECT'),
  'the server service role can read Shorts projects'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.shorts_complete_analysis_job(uuid,uuid,text,text,text,text,jsonb,integer,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'authenticated users cannot complete analysis jobs directly'
);
SELECT ok(
  pg_catalog.to_regprocedure(
    'public.clips_store_shorts_creative_direction(uuid,uuid,uuid,uuid,text,text,jsonb)'
  ) IS NOT NULL,
  'the Opus direction cache RPC is installed'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.clips_store_shorts_creative_direction(uuid,uuid,uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  ),
  'the fenced Opus cache RPC is available to the render worker'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.clips_store_shorts_creative_direction(uuid,uuid,uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.clips_store_shorts_creative_direction(uuid,uuid,uuid,uuid,text,text,jsonb)',
    'EXECUTE'
  ),
  'browser roles cannot write the Opus cache'
);
SELECT is(
  public.clips_store_shorts_creative_direction(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    repeat('a', 64),
    'claude-opus-5-5',
    '{}'::jsonb
  ),
  false,
  'the Opus cache rejects a missing render lease'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.shorts_complete_analysis_job(uuid,uuid,text,text,text,text,jsonb,integer,text,jsonb,jsonb)',
    'EXECUTE'
  ),
  'only the server service role can complete analysis jobs'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shorts_projects'
      AND column_name = 'jev_shadow_consent'
      AND column_default LIKE '%false%'
  ),
  'Jev shadow consent defaults to off'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shorts_publications'
      AND column_name = 'visibility'
      AND column_default LIKE '%private%'
  ),
  'YouTube publication visibility defaults to private'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'youtube_connections'
      AND column_name = 'refresh_token_ciphertext'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'youtube_connections'
      AND column_name = 'refresh_token'
  ),
  'YouTube refresh tokens are stored only as ciphertext'
);

SELECT * FROM finish();

ROLLBACK;
