\set ON_ERROR_STOP on
-- ONLY executed against the disposable local CI Postgres at 127.0.0.1:55322.
DO $$
BEGIN
  IF to_regclass('public.shorts_projects') IS NOT NULL THEN
    RAISE EXCEPTION 'expected old schema before upgrade';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r') <> 8 THEN
    RAISE EXCEPTION 'baseline must contain exactly the eight legacy tables';
  END IF;
END $$;
INSERT INTO auth.users(id,email,raw_user_meta_data)
VALUES('a1111111-2222-4333-8444-555555555555','upgrade-ci@example.invalid','{}'::jsonb);
INSERT INTO public.episodes(id,user_id,title,source_type,status)
VALUES('b1111111-2222-4333-8444-555555555555','a1111111-2222-4333-8444-555555555555',
       'CI upgrade preservation fixture','upload','ready');
