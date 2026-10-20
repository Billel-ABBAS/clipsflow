\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;

SELECT plan(9);

SELECT ok(
  pg_catalog.to_regclass('public.shorts_analysis_worker_health') IS NOT NULL,
  'the analysis worker health table exists'
);
SELECT ok(
  (SELECT relrowsecurity
   FROM pg_catalog.pg_class
   WHERE oid = 'public.shorts_analysis_worker_health'::regclass),
  'the analysis worker health table enables RLS'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.shorts_analysis_worker_health', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.shorts_analysis_worker_health', 'SELECT')
  AND NOT has_table_privilege('service_role', 'public.shorts_analysis_worker_health', 'SELECT'),
  'no API role can read the internal health table directly'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.shorts_record_analysis_worker_heartbeat()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.shorts_record_analysis_worker_heartbeat()',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.shorts_record_analysis_worker_heartbeat()',
    'EXECUTE'
  ),
  'only service_role can record the worker heartbeat'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.shorts_is_analysis_worker_healthy()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.shorts_is_analysis_worker_healthy()',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.shorts_is_analysis_worker_healthy()',
    'EXECUTE'
  ),
  'only service_role can read the heartbeat health result'
);

INSERT INTO public.shorts_analysis_worker_health (singleton, last_heartbeat_at)
VALUES (true, pg_catalog.clock_timestamp() - interval '16 minutes')
ON CONFLICT (singleton) DO UPDATE
  SET last_heartbeat_at = EXCLUDED.last_heartbeat_at;

SELECT is(
  public.shorts_is_analysis_worker_healthy(),
  false,
  'a heartbeat older than fifteen minutes is unhealthy'
);
SELECT is(
  public.shorts_record_analysis_worker_heartbeat(),
  true,
  'the heartbeat RPC confirms its write'
);
SELECT ok(
  (SELECT last_heartbeat_at > pg_catalog.statement_timestamp() - interval '1 minute'
   FROM public.shorts_analysis_worker_health
   WHERE singleton IS TRUE),
  'the heartbeat RPC advances the database timestamp'
);
SELECT is(
  public.shorts_is_analysis_worker_healthy(),
  true,
  'a newly recorded heartbeat is healthy'
);

SELECT * FROM finish();

ROLLBACK;
