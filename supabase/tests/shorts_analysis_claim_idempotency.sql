\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;

SELECT plan(22);

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000011',
  'shorts-claim-idempotency@example.invalid',
  '{}'::jsonb,
  now(),
  now()
);

INSERT INTO public.episodes (id, user_id, title, source_type, status, duration_seconds)
VALUES
  (
    '00000000-0000-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000011',
    'First synthetic claim fixture',
    'upload',
    'ready',
    1200
  ),
  (
    '00000000-0000-4000-8000-000000000013',
    '00000000-0000-4000-8000-000000000011',
    'Second synthetic claim fixture',
    'upload',
    'ready',
    1200
  );

INSERT INTO public.shorts_projects (
  id,
  user_id,
  episode_id,
  analysis_mode,
  source_duration_seconds,
  status,
  idempotency_key
)
VALUES
  (
    '00000000-0000-4000-8000-000000000014',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000012',
    'audio',
    1200,
    'queued',
    '00000000-0000-4000-8000-000000000018'
  ),
  (
    '00000000-0000-4000-8000-000000000015',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000013',
    'audio',
    1200,
    'queued',
    '00000000-0000-4000-8000-000000000019'
  );

INSERT INTO public.shorts_analysis_jobs (
  id,
  project_id,
  user_id,
  episode_id,
  payload,
  created_at
)
VALUES
  (
    '00000000-0000-4000-8000-000000000016',
    '00000000-0000-4000-8000-000000000014',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000012',
    '{"version":"longform-analysis-v1"}'::jsonb,
    now() - interval '2 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000017',
    '00000000-0000-4000-8000-000000000015',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000013',
    '{"version":"longform-analysis-v1"}'::jsonb,
    now() - interval '1 minute'
  );

CREATE TEMP TABLE first_claim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000020',
  1800
);
CREATE TEMP TABLE claim_replay ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000020',
  1800
);

SELECT is(
  (SELECT count(*)::integer FROM first_claim),
  1,
  'a fresh idempotency key claims one job'
);
SELECT is(
  (SELECT id FROM claim_replay),
  (SELECT id FROM first_claim),
  'a replay returns the same job'
);
SELECT is(
  (SELECT lease_token FROM claim_replay),
  (SELECT lease_token FROM first_claim),
  'a replay returns the same lease token'
);
SELECT is(
  (SELECT attempt_count FROM claim_replay),
  1,
  'a replay does not consume another attempt'
);

UPDATE public.shorts_analysis_jobs
SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
    completed_at = now()
WHERE id = '00000000-0000-4000-8000-000000000016';

CREATE TEMP TABLE completed_replay ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000020',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM completed_replay),
  0,
  'a completed claim key is not reassigned to another job'
);

CREATE TEMP TABLE second_claim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000021',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM second_claim),
  1,
  'a fresh key can claim the next queued job'
);
SELECT is(
  (SELECT id FROM second_claim),
  '00000000-0000-4000-8000-000000000017'::uuid,
  'the next queued job remains available after an old-key replay'
);
SELECT is(
  (SELECT attempt_count FROM public.shorts_analysis_jobs
   WHERE id = '00000000-0000-4000-8000-000000000016'),
  1,
  'the completed job still has exactly one claim attempt'
);
SELECT is(
  (SELECT attempt_count FROM second_claim),
  1,
  'the second job starts with one attempt'
);

UPDATE public.shorts_analysis_jobs
SET lease_expires_at = now() - interval '1 minute'
WHERE id = '00000000-0000-4000-8000-000000000017';
CREATE TEMP TABLE expired_replay ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000021',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM expired_replay),
  0,
  'an expired lease replay is not reassigned'
);

CREATE TEMP TABLE reclaimed_claim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000022',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM reclaimed_claim),
  1,
  'a fresh request reclaims an expired job'
);
SELECT is(
  (SELECT id FROM reclaimed_claim),
  '00000000-0000-4000-8000-000000000017'::uuid,
  'the reclaimed job is the same expired job'
);
SELECT is(
  (SELECT attempt_count FROM reclaimed_claim),
  2,
  'reclaiming an expired job consumes exactly one retry'
);

UPDATE public.shorts_analysis_jobs
SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
    completed_at = now()
WHERE id = '00000000-0000-4000-8000-000000000017';

CREATE TEMP TABLE idle_claim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000030',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM idle_claim),
  0,
  'a fresh request records an empty-queue result'
);

INSERT INTO public.episodes (id, user_id, title, source_type, status, duration_seconds)
VALUES (
  '00000000-0000-4000-8000-000000000023',
  '00000000-0000-4000-8000-000000000011',
  'Third synthetic claim fixture',
  'upload',
  'ready',
  1200
);
INSERT INTO public.shorts_projects (
  id, user_id, episode_id, analysis_mode, source_duration_seconds, status, idempotency_key
)
VALUES (
  '00000000-0000-4000-8000-000000000024',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000023',
  'audio', 1200, 'queued', '00000000-0000-4000-8000-000000000025'
);
INSERT INTO public.shorts_analysis_jobs (id, project_id, user_id, episode_id, payload)
VALUES (
  '00000000-0000-4000-8000-000000000026',
  '00000000-0000-4000-8000-000000000024',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000023',
  '{"version":"longform-analysis-v1"}'::jsonb
);

CREATE TEMP TABLE idle_replay ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000030',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM idle_replay),
  0,
  'an idle request replay does not take work that arrived later'
);
CREATE TEMP TABLE third_claim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000031',
  1800
);
SELECT is(
  (SELECT id FROM third_claim),
  '00000000-0000-4000-8000-000000000026'::uuid,
  'a fresh key can claim work that arrived after the idle response'
);

INSERT INTO public.episodes (id, user_id, title, source_type, status, duration_seconds)
VALUES (
  '00000000-0000-4000-8000-000000000033',
  '00000000-0000-4000-8000-000000000011',
  'Non-queueable synthetic claim fixture',
  'upload',
  'ready',
  1200
);
INSERT INTO public.shorts_projects (
  id, user_id, episode_id, analysis_mode, source_duration_seconds, status, idempotency_key
)
VALUES (
  '00000000-0000-4000-8000-000000000032',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000033',
  'audio', 1200, 'failed', '00000000-0000-4000-8000-000000000034'
);
INSERT INTO public.shorts_analysis_jobs (id, project_id, user_id, episode_id, payload)
VALUES (
  '00000000-0000-4000-8000-000000000035',
  '00000000-0000-4000-8000-000000000032',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000033',
  '{"version":"longform-analysis-v1"}'::jsonb
);

CREATE TEMP TABLE non_queueable_claim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000036',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM non_queueable_claim),
  0,
  'a non-queueable project is recorded as an empty outcome'
);
SELECT is(
  (SELECT status FROM public.shorts_analysis_jobs
   WHERE id = '00000000-0000-4000-8000-000000000035'),
  'failed',
  'a non-queueable project job reaches a visible failure'
);

INSERT INTO public.episodes (id, user_id, title, source_type, status, duration_seconds)
VALUES (
  '00000000-0000-4000-8000-000000000037',
  '00000000-0000-4000-8000-000000000011',
  'Fourth synthetic claim fixture',
  'upload',
  'ready',
  1200
);
INSERT INTO public.shorts_projects (
  id, user_id, episode_id, analysis_mode, source_duration_seconds, status, idempotency_key
)
VALUES (
  '00000000-0000-4000-8000-000000000038',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000037',
  'audio', 1200, 'queued', '00000000-0000-4000-8000-000000000039'
);
INSERT INTO public.shorts_analysis_jobs (id, project_id, user_id, episode_id, payload)
VALUES (
  '00000000-0000-4000-8000-000000000040',
  '00000000-0000-4000-8000-000000000038',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000037',
  '{"version":"longform-analysis-v1"}'::jsonb
);

CREATE TEMP TABLE non_queueable_replay ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000036',
  1800
);
SELECT is(
  (SELECT count(*)::integer FROM non_queueable_replay),
  0,
  'a non-queueable result replay does not take later work'
);
CREATE TEMP TABLE fourth_claim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000041',
  1800
);
SELECT is(
  (SELECT id FROM fourth_claim),
  '00000000-0000-4000-8000-000000000040'::uuid,
  'a fresh key can claim work after a non-queueable result'
);

-- Legacy claim calls could pass NULL for the lease duration, leaving jobs in
-- processing with no expiration. The current claim sweep must recover them.
UPDATE public.shorts_analysis_jobs
SET lease_expires_at = NULL
WHERE id = '00000000-0000-4000-8000-000000000040';
CREATE TEMP TABLE null_lease_reclaim ON COMMIT DROP AS
SELECT *
FROM public.shorts_claim_analysis_job_idempotent(
  '00000000-0000-4000-8000-000000000042',
  1800
);
SELECT is(
  (SELECT id FROM null_lease_reclaim),
  '00000000-0000-4000-8000-000000000040'::uuid,
  'a processing job with a legacy null lease is reclaimed'
);
SELECT is(
  (SELECT attempt_count FROM null_lease_reclaim),
  2,
  'reclaiming a null lease uses the existing single-retry policy'
);

SELECT * FROM finish();

ROLLBACK;
