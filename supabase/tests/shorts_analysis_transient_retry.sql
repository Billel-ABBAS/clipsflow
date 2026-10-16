\set ON_ERROR_STOP on

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;
SELECT plan(17);

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000071',
  'shorts-transient-retry@example.invalid',
  '{}'::jsonb,
  now(),
  now()
);

INSERT INTO public.episodes (id, user_id, title, source_type, status, duration_seconds)
VALUES (
  '00000000-0000-4000-8000-000000000072',
  '00000000-0000-4000-8000-000000000071',
  'Transient retry fixture',
  'upload',
  'ready',
  1200
);

INSERT INTO public.shorts_projects (
  id, user_id, episode_id, analysis_mode, source_duration_seconds,
  requested_source_duration_seconds, status, idempotency_key
)
VALUES
  (
    '00000000-0000-4000-8000-000000000073',
    '00000000-0000-4000-8000-000000000071',
    '00000000-0000-4000-8000-000000000072',
    'audio', 1200, 1200, 'transcribing',
    '00000000-0000-4000-8000-000000000074'
  ),
  (
    '00000000-0000-4000-8000-000000000075',
    '00000000-0000-4000-8000-000000000071',
    '00000000-0000-4000-8000-000000000072',
    'audio', 1200, 1200, 'transcribing',
    '00000000-0000-4000-8000-000000000076'
  );

INSERT INTO public.shorts_analysis_jobs (
  id, project_id, user_id, episode_id, payload, status, attempt_count,
  claimed_at, lease_token, lease_expires_at
)
VALUES
  (
    '00000000-0000-4000-8000-000000000077',
    '00000000-0000-4000-8000-000000000073',
    '00000000-0000-4000-8000-000000000071',
    '00000000-0000-4000-8000-000000000072',
    '{}'::jsonb, 'processing', 1, now(),
    '00000000-0000-4000-8000-000000000078', now() + interval '30 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000079',
    '00000000-0000-4000-8000-000000000075',
    '00000000-0000-4000-8000-000000000071',
    '00000000-0000-4000-8000-000000000072',
    '{}'::jsonb, 'processing', 1, now(),
    '00000000-0000-4000-8000-000000000080', now() + interval '30 minutes'
  );

INSERT INTO public.shorts_analysis_quota_usage (
  user_id, period_start, reserved_source_seconds
)
VALUES (
  '00000000-0000-4000-8000-000000000071',
  pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', now()))::date,
  1200
);
INSERT INTO public.shorts_analysis_quota_reservations (
  user_id, project_id, idempotency_key, period_start,
  source_duration_seconds, quota_limit_source_seconds
)
VALUES (
  '00000000-0000-4000-8000-000000000071',
  '00000000-0000-4000-8000-000000000073',
  '00000000-0000-4000-8000-000000000074',
  pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', now()))::date,
  1200,
  7200
);

SELECT ok(
  pg_catalog.to_regprocedure(
    'public.shorts_fail_or_retry_analysis_job(uuid,uuid,text,boolean)'
  ) IS NOT NULL,
  'the fenced failure-or-retry RPC exists'
);
SELECT ok(has_function_privilege(
  'service_role',
  'public.shorts_fail_or_retry_analysis_job(uuid,uuid,text,boolean)',
  'EXECUTE'
), 'service_role can invoke the retry RPC');
SELECT ok(
  NOT has_function_privilege(
    'anon', 'public.shorts_fail_or_retry_analysis_job(uuid,uuid,text,boolean)', 'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated', 'public.shorts_fail_or_retry_analysis_job(uuid,uuid,text,boolean)', 'EXECUTE'
  ),
  'browser roles cannot invoke the retry RPC'
);
SELECT ok(
  public.shorts_fail_or_retry_analysis_job(
    '00000000-0000-4000-8000-000000000077',
    '00000000-0000-4000-8000-000000000078',
    'analysis_provider_transient',
    true
  ), 'the first transient failure schedules a bounded retry'
);
SELECT is(
  (SELECT status FROM public.shorts_analysis_jobs
   WHERE id = '00000000-0000-4000-8000-000000000077'),
  'pending', 'the retry returns the job to the queue'
);
SELECT ok(
  (SELECT attempt_count = 1 AND claimed_at IS NULL AND lease_token IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NULL
   FROM public.shorts_analysis_jobs
   WHERE id = '00000000-0000-4000-8000-000000000077'),
  'the requeue releases its lease without consuming a claim'
);
SELECT is(
  (SELECT status FROM public.shorts_projects
   WHERE id = '00000000-0000-4000-8000-000000000073'),
  'queued', 'the project returns to queued state'
);
SELECT is(
  (SELECT status FROM public.shorts_analysis_quota_reservations
   WHERE project_id = '00000000-0000-4000-8000-000000000073'),
  'reserved', 'the retry retains its quota reservation'
);
SELECT is(
  (SELECT reserved_source_seconds FROM public.shorts_analysis_quota_usage
   WHERE user_id = '00000000-0000-4000-8000-000000000071'),
  1200::bigint, 'retry does not release the held source seconds'
);

CREATE TEMP TABLE retry_claim ON COMMIT DROP AS
SELECT * FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000081', 1800
);
SELECT is(
  (SELECT id FROM retry_claim),
  '00000000-0000-4000-8000-000000000077'::uuid,
  'the requeued job can be claimed again'
);
SELECT is(
  (SELECT attempt_count FROM retry_claim),
  2, 'the second claim consumes the final allowed attempt'
);
SELECT ok(
  public.shorts_fail_or_retry_analysis_job(
    '00000000-0000-4000-8000-000000000077',
    (SELECT lease_token FROM retry_claim),
    'analysis_provider_transient',
    true
  ), 'a second transient failure is terminal'
);
SELECT is(
  (SELECT status FROM public.shorts_analysis_jobs
   WHERE id = '00000000-0000-4000-8000-000000000077'),
  'failed', 'exhausted retries fail the job'
);
SELECT is(
  (SELECT status FROM public.shorts_analysis_quota_reservations
   WHERE project_id = '00000000-0000-4000-8000-000000000073'),
  'released', 'terminal failure releases the quota reservation'
);
SELECT is(
  (SELECT reserved_source_seconds FROM public.shorts_analysis_quota_usage
   WHERE user_id = '00000000-0000-4000-8000-000000000071'),
  0::bigint, 'terminal failure releases the held source seconds'
);
SELECT ok(
  public.shorts_fail_or_retry_analysis_job(
    '00000000-0000-4000-8000-000000000079',
    '00000000-0000-4000-8000-000000000080',
    'transcription_failed',
    false
  ), 'a permanent failure is terminal on its first attempt'
);
SELECT is(
  (SELECT status FROM public.shorts_analysis_jobs
   WHERE id = '00000000-0000-4000-8000-000000000079'),
  'failed', 'permanent errors do not enter the retry queue'
);

SELECT * FROM finish();
ROLLBACK;
