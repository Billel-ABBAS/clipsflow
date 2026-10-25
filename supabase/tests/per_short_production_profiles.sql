\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA public;

SELECT plan(8);

-- Some preserved local databases predate the canonical migration history and
-- still carry this now-unused required column. This suite runs in an outer
-- transaction and rolls the compatibility adjustment back; the contract under
-- test does not read or write the legacy column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shorts_candidates'
      AND column_name = 'analysis_source_rank'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.shorts_candidates
      ALTER COLUMN analysis_source_rank DROP NOT NULL;
  END IF;
END;
$$;

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000009901',
  'per-short-profiles@example.invalid',
  '{}'::jsonb,
  now(),
  now()
);

INSERT INTO public.episodes (
  id,
  user_id,
  title,
  source_type,
  status,
  duration_seconds
)
VALUES (
  '00000000-0000-4000-8000-000000009902',
  '00000000-0000-4000-8000-000000009901',
  'Per-Short profile fixture',
  'upload',
  'ready',
  120
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
VALUES (
  '00000000-0000-4000-8000-000000009903',
  '00000000-0000-4000-8000-000000009901',
  '00000000-0000-4000-8000-000000009902',
  'audio',
  120,
  'ready',
  '00000000-0000-4000-8000-000000009904'
);

INSERT INTO public.shorts_candidates (
  id,
  project_id,
  user_id,
  episode_id,
  rank,
  start_seconds,
  end_seconds,
  score,
  hook,
  title,
  rationale,
  transcript_excerpt,
  music_mood,
  motion_direction,
  production_profile
)
VALUES
  (
    '00000000-0000-4000-8000-000000009905',
    '00000000-0000-4000-8000-000000009903',
    '00000000-0000-4000-8000-000000009901',
    '00000000-0000-4000-8000-000000009902',
    1,
    0,
    30,
    92,
    'First bounded hook',
    'First candidate',
    'First bounded rationale',
    'First bounded transcript excerpt',
    'focused',
    'Keep movement restrained.',
    '{}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000009906',
    '00000000-0000-4000-8000-000000009903',
    '00000000-0000-4000-8000-000000009901',
    '00000000-0000-4000-8000-000000009902',
    2,
    40,
    70,
    89,
    'Second bounded hook',
    'Second candidate',
    'Second bounded rationale',
    'Second bounded transcript excerpt',
    'minimal',
    'Keep the frame static.',
    '{}'::jsonb
  );

SELECT is(
  public.shorts_set_selected_candidate_profiles(
    '00000000-0000-4000-8000-000000009901',
    '00000000-0000-4000-8000-000000009903',
    jsonb_build_array(
      jsonb_build_object(
        'candidate_id', '00000000-0000-4000-8000-000000009905',
        'production_profile', '{"aspect_ratio":"9:16","music":"off"}'::jsonb
      ),
      jsonb_build_object(
        'candidate_id', '00000000-0000-4000-8000-000000009906',
        'production_profile', '{"aspect_ratio":"1:1","motion":"reduced"}'::jsonb
      )
    )
  ),
  2,
  'the RPC selects both owned candidates atomically'
);

SELECT is(
  (SELECT count(*)::integer FROM public.shorts_candidates WHERE selected),
  2,
  'both selected candidates remain selected'
);

SELECT is(
  (
    SELECT production_profile
    FROM public.shorts_candidates
    WHERE id = '00000000-0000-4000-8000-000000009905'
  ),
  '{"aspect_ratio":"9:16","music":"off"}'::jsonb,
  'the first candidate retains its own profile'
);

SELECT is(
  (
    SELECT production_profile
    FROM public.shorts_candidates
    WHERE id = '00000000-0000-4000-8000-000000009906'
  ),
  '{"aspect_ratio":"1:1","motion":"reduced"}'::jsonb,
  'the second candidate retains a different profile'
);

SELECT throws_ok(
  $$
    SELECT public.shorts_set_selected_candidate_profiles(
      '00000000-0000-4000-8000-000000009901',
      '00000000-0000-4000-8000-000000009903',
      jsonb_build_array(
        jsonb_build_object('candidate_id', '00000000-0000-4000-8000-000000009905', 'production_profile', '{}'::jsonb),
        jsonb_build_object('candidate_id', '00000000-0000-4000-8000-000000009905', 'production_profile', '{}'::jsonb)
      )
    )
  $$,
  '22023',
  'invalid_candidate_selection',
  'duplicate candidate IDs are rejected before changing selection'
);

SELECT throws_ok(
  $$
    SELECT public.shorts_set_selected_candidate_profiles(
      '00000000-0000-4000-8000-000000009901',
      '00000000-0000-4000-8000-000000009903',
      jsonb_build_array(
        jsonb_build_object('candidate_id', '00000000-0000-4000-8000-000000009909', 'production_profile', '{}'::jsonb)
      )
    )
  $$,
  '22023',
  'candidate_not_in_project',
  'foreign or missing candidates are rejected'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.shorts_set_selected_candidate_profiles(uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'
  ),
  'anon cannot execute the selection RPC directly'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.shorts_set_selected_candidate_profiles(uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'
  ),
  'only service_role receives execution privilege'
);

SELECT * FROM finish();

ROLLBACK;
