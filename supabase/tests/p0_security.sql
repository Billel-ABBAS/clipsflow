\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  table_name text;
  forced boolean;
  function_signature text := 'public.clips_submit_job(uuid,uuid,integer,integer,text,text,text,jsonb,jsonb)';
  rate_function_signature text := 'public.consume_api_rate_limit(text,integer,integer)';
  stripe_claim_signature text := 'public.stripe_claim_webhook_event(text,bigint,text)';
  stripe_apply_signature text := 'public.stripe_apply_profile_event(uuid,bigint,text,text,text,text,boolean)';
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'profiles',
    'episodes',
    'clips',
    'jobs',
    'api_rate_limits',
    'stripe_webhook_events'
  ]
  LOOP
    SELECT cls.relforcerowsecurity
      INTO forced
    FROM pg_catalog.pg_class AS cls
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = cls.relnamespace
    WHERE ns.nspname = 'public' AND cls.relname = table_name;
    IF forced IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RLS is not forced on public.%', table_name;
    END IF;
  END LOOP;

  IF has_table_privilege('authenticated', 'public.episodes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.episodes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.clips', 'INSERT')
     OR has_table_privilege('authenticated', 'public.clips', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.jobs', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated retains a lifecycle mutation privilege';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.profiles', 'locale', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'plan', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'clip_seconds_used_this_month', 'UPDATE') THEN
    RAISE EXCEPTION 'profile column privileges are not least-privilege';
  END IF;

  IF has_function_privilege('anon', function_signature, 'EXECUTE')
     OR has_function_privilege('authenticated', function_signature, 'EXECUTE')
     OR NOT has_function_privilege('service_role', function_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'clips_submit_job execute privileges are unsafe';
  END IF;

  IF has_table_privilege('authenticated', 'public.api_rate_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.api_rate_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.api_rate_limits', 'UPDATE')
     OR has_function_privilege('anon', rate_function_signature, 'EXECUTE')
     OR has_function_privilege('authenticated', rate_function_signature, 'EXECUTE')
     OR NOT has_function_privilege('service_role', rate_function_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'distributed rate limit privileges are unsafe';
  END IF;

  IF has_table_privilege('authenticated', 'public.stripe_webhook_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.stripe_webhook_events', 'INSERT')
     OR has_function_privilege('anon', stripe_claim_signature, 'EXECUTE')
     OR has_function_privilege('authenticated', stripe_claim_signature, 'EXECUTE')
     OR NOT has_function_privilege('service_role', stripe_claim_signature, 'EXECUTE')
     OR has_function_privilege('authenticated', stripe_apply_signature, 'EXECUTE')
     OR NOT has_function_privilege('service_role', stripe_apply_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'Stripe webhook privileges are unsafe';
  END IF;
END;
$$;

INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'p0-local@example.invalid',
  '{}'::jsonb,
  now(),
  now()
);

INSERT INTO public.episodes (id, user_id, title, source_type, source_url, status)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'P0 local test',
  'url',
  'https://example.invalid/source.mp4',
  'ready'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

DO $$
DECLARE
  submitted record;
  denied record;
  rate_result record;
  stripe_action text;
  stripe_applied boolean;
  profile_plan text;
  profile_status text;
  profile_event_created bigint;
  used_seconds integer;
  clip_count integer;
  job_count integer;
BEGIN
  SELECT * INTO submitted
  FROM public.clips_submit_job(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    0,
    30,
    'viral',
    '9:16',
    'fr',
    '{}'::jsonb,
    '[]'::jsonb
  );

  IF submitted.error_code IS NOT NULL
     OR submitted.clip_id IS NULL
     OR submitted.job_id IS NULL
     OR submitted.remaining_seconds <> 30 THEN
    RAISE EXCEPTION 'valid submission returned an invalid result';
  END IF;

  SELECT clip_seconds_used_this_month INTO used_seconds
  FROM public.profiles
  WHERE id = '00000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO clip_count FROM public.clips;
  SELECT count(*) INTO job_count FROM public.jobs;
  IF used_seconds <> 30 OR clip_count <> 1 OR job_count <> 1 THEN
    RAISE EXCEPTION 'valid submission was not atomic';
  END IF;

  SELECT * INTO denied
  FROM public.clips_submit_job(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    0,
    31,
    'viral',
    '9:16',
    'fr',
    '{}'::jsonb,
    '[]'::jsonb
  );
  IF denied.error_code <> 'quota_exceeded' OR denied.remaining_seconds <> 30 THEN
    RAISE EXCEPTION 'quota denial returned an invalid result';
  END IF;

  BEGIN
    PERFORM public.clips_submit_job(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      0,
      10,
      'invalid-style',
      '9:16',
      'fr',
      '{}'::jsonb,
      '[]'::jsonb
    );
    RAISE EXCEPTION 'invalid clip unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  SELECT clip_seconds_used_this_month INTO used_seconds
  FROM public.profiles
  WHERE id = '00000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO clip_count FROM public.clips;
  SELECT count(*) INTO job_count FROM public.jobs;
  IF used_seconds <> 30 OR clip_count <> 1 OR job_count <> 1 THEN
    RAISE EXCEPTION 'failed submission left partial state';
  END IF;

  SELECT * INTO rate_result
  FROM public.consume_api_rate_limit('p0:test-user', 2, 60);
  IF rate_result.allowed IS DISTINCT FROM true OR rate_result.retry_after_seconds <> 0 THEN
    RAISE EXCEPTION 'first distributed rate token should be allowed';
  END IF;

  SELECT * INTO rate_result
  FROM public.consume_api_rate_limit('p0:test-user', 2, 60);
  IF rate_result.allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'second distributed rate token should be allowed';
  END IF;

  SELECT * INTO rate_result
  FROM public.consume_api_rate_limit('p0:test-user', 2, 60);
  IF rate_result.allowed IS DISTINCT FROM false
     OR rate_result.retry_after_seconds NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'third distributed rate token should be denied';
  END IF;

  stripe_action := public.stripe_claim_webhook_event(
    'evt_p0_retry',
    200,
    'customer.subscription.updated'
  );
  IF stripe_action <> 'process' THEN
    RAISE EXCEPTION 'new Stripe event should be claimed';
  END IF;
  IF public.stripe_claim_webhook_event(
    'evt_p0_retry',
    200,
    'customer.subscription.updated'
  ) <> 'skip' THEN
    RAISE EXCEPTION 'in-flight Stripe duplicate should be skipped';
  END IF;

  PERFORM public.stripe_fail_webhook_event('evt_p0_retry', 'expected test failure');
  IF public.stripe_claim_webhook_event(
    'evt_p0_retry',
    200,
    'customer.subscription.updated'
  ) <> 'process' THEN
    RAISE EXCEPTION 'failed Stripe event should be retryable';
  END IF;
  PERFORM public.stripe_complete_webhook_event('evt_p0_retry');
  IF public.stripe_claim_webhook_event(
    'evt_p0_retry',
    200,
    'customer.subscription.updated'
  ) <> 'skip' THEN
    RAISE EXCEPTION 'processed Stripe event should be idempotent';
  END IF;

  stripe_applied := public.stripe_apply_profile_event(
    '00000000-0000-4000-8000-000000000001',
    200,
    'pro',
    'cus_p0',
    'sub_p0',
    'active',
    false
  );
  IF stripe_applied IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'new Stripe profile event should apply';
  END IF;

  stripe_applied := public.stripe_apply_profile_event(
    '00000000-0000-4000-8000-000000000001',
    100,
    'free',
    'cus_p0',
    NULL,
    'canceled',
    true
  );
  IF stripe_applied IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'stale Stripe profile event should be ignored';
  END IF;

  SELECT plan, subscription_status, stripe_event_created_at
    INTO profile_plan, profile_status, profile_event_created
  FROM public.profiles
  WHERE id = '00000000-0000-4000-8000-000000000001';
  IF profile_plan <> 'pro'
     OR profile_status <> 'active'
     OR profile_event_created <> 200 THEN
    RAISE EXCEPTION 'stale Stripe event regressed profile state';
  END IF;
END;
$$;

ROLLBACK;
