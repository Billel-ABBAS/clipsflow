\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;

SELECT plan(9);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'shorts_projects_duration_range'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%60%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%14400%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%1200%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%7200%'
  ),
  'verified source duration constraint accepts 1 minute through 4 hours'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'shorts_projects_requested_duration_range'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%60%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%14400%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%1200%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%7200%'
  ),
  'requested source duration constraint accepts 1 minute through 4 hours'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'shorts_analysis_quota_reservations_source_duration_seconds_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%60%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%14400%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%1200%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%7200%'
  ),
  'quota reservation constraint accepts 1 minute through 4 hours'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.shorts_analysis_quota_reservations'::regclass
      AND conname = 'shorts_analysis_quota_reservation_source_duration_seconds_check'
  ),
  'obsolete 20-minute to 2-hour quota constraint is removed'
);

SELECT ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.shorts_submit_analysis_job(uuid,uuid,text,integer,text,boolean,uuid)'::regprocedure),
    '60 AND 14400'
  ) > 0
    AND pg_catalog.strpos(
      pg_catalog.pg_get_functiondef('public.shorts_submit_analysis_job(uuid,uuid,text,integer,text,boolean,uuid)'::regprocedure),
      '1200 AND 7200'
    ) = 0,
  'legacy submission RPC no longer rejects the expanded range'
);
SELECT ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.shorts_complete_analysis_job(uuid,uuid,text,text,text,text,jsonb,integer,text,jsonb,jsonb)'::regprocedure),
    '60 AND 14400'
  ) > 0
    AND pg_catalog.strpos(
      pg_catalog.pg_get_functiondef('public.shorts_complete_analysis_job(uuid,uuid,text,text,text,text,jsonb,integer,text,jsonb,jsonb)'::regprocedure),
      '1200 AND 7200'
    ) = 0,
  'analysis completion RPC accepts verified 1 minute to 4 hour sources'
);
SELECT ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.shorts_finalize_analysis_quota_reservation()'::regprocedure),
    '60 AND 14400'
  ) > 0
    AND pg_catalog.strpos(
      pg_catalog.pg_get_functiondef('public.shorts_finalize_analysis_quota_reservation()'::regprocedure),
      '1200 AND 7200'
    ) = 0,
  'quota finalization accepts verified 1 minute to 4 hour sources'
);
SELECT ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.shorts_submit_analysis_job_with_quota(uuid,uuid,text,integer,text,boolean,uuid,integer)'::regprocedure),
    '60 AND 14400'
  ) > 0
    AND pg_catalog.strpos(
      pg_catalog.pg_get_functiondef('public.shorts_submit_analysis_job_with_quota(uuid,uuid,text,integer,text,boolean,uuid,integer)'::regprocedure),
      '1200 AND 7200'
    ) = 0,
  'quota-aware submission accepts 1 minute to 4 hour sources'
);
SELECT ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('public.shorts_adjust_analysis_quota(uuid,uuid,integer)'::regprocedure),
    '60 AND 14400'
  ) > 0
    AND pg_catalog.strpos(
      pg_catalog.pg_get_functiondef('public.shorts_adjust_analysis_quota(uuid,uuid,integer)'::regprocedure),
      '1200 AND 7200'
    ) = 0,
  'quota adjustment accepts verified 1 minute to 4 hour sources'
);

SELECT * FROM finish();

ROLLBACK;
