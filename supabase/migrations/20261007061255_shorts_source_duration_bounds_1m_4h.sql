-- Expand long-form Shorts analysis from 20m–2h to 1m–4h. Historical
-- migrations remain immutable; every runtime guard and persistent constraint
-- is updated here so API, worker, quota ledger, and database agree.

ALTER TABLE public.shorts_projects
  DROP CONSTRAINT IF EXISTS shorts_projects_duration_range,
  ADD CONSTRAINT shorts_projects_duration_range
    CHECK (
      source_duration_seconds IS NULL
      OR source_duration_seconds BETWEEN 60 AND 14400
    ),
  DROP CONSTRAINT IF EXISTS shorts_projects_requested_duration_range,
  ADD CONSTRAINT shorts_projects_requested_duration_range
    CHECK (
      requested_source_duration_seconds IS NULL
      OR requested_source_duration_seconds BETWEEN 60 AND 14400
    );

ALTER TABLE public.shorts_analysis_quota_reservations
  DROP CONSTRAINT IF EXISTS shorts_analysis_quota_reservations_source_duration_seconds_check,
  ADD CONSTRAINT shorts_analysis_quota_reservations_source_duration_seconds_check
    CHECK (source_duration_seconds BETWEEN 60 AND 14400);

-- Preserve each function's existing access attributes, grants, and body while
-- changing only the source-duration predicate. Exact signatures and a required
-- old bound make unexpected schema drift fail the migration instead of
-- silently leaving a stale limit active.
DO $migration$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_updated_definition text;
  v_signatures regprocedure[] := ARRAY[
    'public.shorts_submit_analysis_job(uuid,uuid,text,integer,text,boolean,uuid)'::regprocedure,
    'public.shorts_complete_analysis_job(uuid,uuid,text,text,text,text,jsonb,integer,text,jsonb,jsonb)'::regprocedure,
    'public.shorts_finalize_analysis_quota_reservation()'::regprocedure,
    'public.shorts_submit_analysis_job_with_quota(uuid,uuid,text,integer,text,boolean,uuid,integer)'::regprocedure,
    'public.shorts_adjust_analysis_quota(uuid,uuid,integer)'::regprocedure
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    IF pg_catalog.strpos(v_definition, '1200 AND 7200') = 0 THEN
      RAISE EXCEPTION 'Expected legacy source-duration guard missing in %',
        v_signature;
    END IF;

    v_updated_definition := pg_catalog.replace(
      v_definition,
      '1200 AND 7200',
      '60 AND 14400'
    );
    EXECUTE pg_catalog.regexp_replace(
      v_updated_definition,
      ';[[:space:]]*$',
      ''
    );
  END LOOP;
END
$migration$;

COMMENT ON FUNCTION public.shorts_submit_analysis_job(
  uuid, uuid, text, integer, text, boolean, uuid
) IS 'Idempotently creates a 1 minute to 4 hour Shorts analysis project and queue job; Jev transcript sharing is opt-in.';

COMMENT ON FUNCTION public.shorts_submit_analysis_job_with_quota(
  uuid, uuid, text, integer, text, boolean, uuid, integer
) IS 'Atomically reserves monthly source-seconds quota and creates one idempotent 1 minute to 4 hour analysis project and queue job.';
