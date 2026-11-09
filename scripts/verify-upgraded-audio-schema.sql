\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  name text;
  owner_id uuid := 'a1111111-2222-4333-8444-555555555555';
  episode_id uuid := 'b1111111-2222-4333-8444-555555555555';
  project_id uuid := gen_random_uuid();
BEGIN
  IF to_regclass('public.shorts_audio_assets') IS NULL THEN
    RAISE EXCEPTION 'UPGRADE_NOT_APPLIED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.episodes e WHERE e.id=episode_id
    AND e.title='CI upgrade preservation fixture' AND e.user_id=owner_id) THEN
    RAISE EXCEPTION 'baseline fixture lost';
  END IF;
  FOREACH name IN ARRAY ARRAY['shorts_projects','shorts_candidates','shorts_audio_assets',
    'shorts_analysis_jobs','youtube_connections','shorts_publications'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=name AND c.relrowsecurity AND c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'missing protected table %',name;
    END IF;
    IF has_table_privilege('anon',format('public.%I',name),'SELECT') OR
      has_table_privilege('authenticated',format('public.%I',name),'SELECT') OR
      NOT has_table_privilege('service_role',format('public.%I',name),'SELECT') THEN
      RAISE EXCEPTION 'wrong permissions on %',name;
    END IF;
  END LOOP;
  INSERT INTO public.shorts_projects(id,user_id,episode_id,analysis_mode,idempotency_key,source_duration_seconds)
  VALUES(project_id,owner_id,episode_id,'audio',gen_random_uuid(),60);
  FOREACH name IN ARRAY ARRAY['elevenlabs','licensed_catalog','soundbox'] LOOP
    INSERT INTO public.shorts_audio_assets(user_id,project_id,provider,kind,storage_path,duration_seconds)
    VALUES(owner_id,project_id,name,'music','ci-only/fake-audio.mp3',10);
  END LOOP;
  BEGIN
    INSERT INTO public.shorts_audio_assets(user_id,project_id,provider,kind,storage_path,duration_seconds)
    VALUES(owner_id,project_id,'unapproved','music','ci-only/fake-audio.mp3',10);
    RAISE EXCEPTION 'unknown provider was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='clip-sources' AND NOT public
    AND file_size_limit=8589934592) THEN RAISE EXCEPTION 'source bucket contract invalid'; END IF;
  RAISE NOTICE 'UPGRADE_ACCEPTANCE_PASS; fixture preserved, providers checked, private access unchanged';
END $$;
ROLLBACK;
