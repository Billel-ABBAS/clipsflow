\set ON_ERROR_STOP on
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;
SELECT plan(12);

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'target-a@example.invalid', '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-000000000102', 'target-b@example.invalid', '{}'::jsonb, now(), now());
INSERT INTO public.episodes (id, user_id, title, source_type, status, duration_seconds)
VALUES
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000101', 'Target A', 'upload', 'ready', 1200),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000102', 'Target B', 'upload', 'ready', 1200);
INSERT INTO public.shorts_projects (id, user_id, episode_id, analysis_mode, source_duration_seconds, requested_source_duration_seconds, status, idempotency_key)
VALUES
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000103', 'audio', 1200, 1200, 'queued', '00000000-0000-4000-8000-000000000106'),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000104', 'audio', 1200, 1200, 'queued', '00000000-0000-4000-8000-000000000108'),
  ('00000000-0000-4000-8000-000000000109', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000104', 'audio', 1200, 1200, 'transcribing', '00000000-0000-4000-8000-000000000110');
INSERT INTO public.shorts_analysis_jobs (id, project_id, user_id, episode_id, payload, status, attempt_count, claimed_at, lease_token, lease_expires_at)
VALUES
  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000103', '{}'::jsonb, 'pending', 0, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000104', '{}'::jsonb, 'pending', 0, NULL, NULL, NULL),
  ('00000000-0000-4000-8000-000000000113', '00000000-0000-4000-8000-000000000109', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000104', '{}'::jsonb, 'processing', 1, now() - interval '1 hour', '00000000-0000-4000-8000-000000000114', now() - interval '1 minute');

INSERT INTO public.shorts_analysis_claim_requests (request_id, outcome, created_at)
VALUES
  ('00000000-0000-4000-8000-000000000118', 'empty', now() - interval '16 minutes'),
  ('00000000-0000-4000-8000-000000000119', 'empty', now());

SELECT ok(has_function_privilege('service_role', 'public.shorts_claim_analysis_targeted(uuid,uuid,uuid,integer)', 'EXECUTE'), 'service role may claim');
SELECT ok(NOT has_function_privilege('anon', 'public.shorts_claim_analysis_targeted(uuid,uuid,uuid,integer)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.shorts_claim_analysis_targeted(uuid,uuid,uuid,integer)', 'EXECUTE'), 'browser roles cannot claim');
CREATE TEMP TABLE wrong_owner AS SELECT * FROM public.shorts_claim_analysis_targeted('00000000-0000-4000-8000-000000000115', '00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000102', 1800);
SELECT is((SELECT count(*) FROM wrong_owner), 0::bigint, 'wrong owner cannot claim target');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.shorts_analysis_claim_requests WHERE request_id = '00000000-0000-4000-8000-000000000118'), 'expired empty request is pruned');
SELECT ok(EXISTS (SELECT 1 FROM public.shorts_analysis_claim_requests WHERE request_id = '00000000-0000-4000-8000-000000000119'), 'recent empty request is retained');
CREATE TEMP TABLE targeted AS SELECT * FROM public.shorts_claim_analysis_targeted('00000000-0000-4000-8000-000000000116', '00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101', 1800);
SELECT is((SELECT id FROM targeted), '00000000-0000-4000-8000-000000000111'::uuid, 'only the target is claimed');
SELECT is((SELECT attempt_count FROM targeted), 1, 'target has a single initial attempt');
SELECT is((SELECT status FROM public.shorts_analysis_jobs WHERE id = '00000000-0000-4000-8000-000000000112'), 'pending', 'other queued job is untouched');
SELECT is((SELECT status FROM public.shorts_analysis_jobs WHERE id = '00000000-0000-4000-8000-000000000113'), 'processing', 'other expired lease is not swept');
CREATE TEMP TABLE replay AS SELECT * FROM public.shorts_claim_analysis_targeted('00000000-0000-4000-8000-000000000116', '00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101', 1800);
SELECT is((SELECT lease_token FROM replay), (SELECT lease_token FROM targeted), 'same request replays the same live lease');
CREATE TEMP TABLE second_claim AS SELECT * FROM public.shorts_claim_analysis_targeted('00000000-0000-4000-8000-000000000117', '00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101', 1800);
SELECT is((SELECT count(*) FROM second_claim), 0::bigint, 'new request cannot claim processing target');
SELECT throws_ok($$SELECT * FROM public.shorts_claim_analysis_targeted(NULL, NULL, NULL, 1800)$$, '22023', 'targeted_claim_identifiers_required', 'missing identifiers fail closed');
SELECT * FROM finish();
ROLLBACK;
