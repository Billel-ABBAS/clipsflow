-- Read-only schema inventory. Explicitly select the project in the client.
-- No user rows, tokens, function bodies, or writes are returned/performed.
SELECT jsonb_build_object(
  'tables', (SELECT jsonb_agg(jsonb_build_object(
    'name', c.relname, 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity
  ) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'),
  'migration_history_present', to_regclass('supabase_migrations.schema_migrations') IS NOT NULL,
  'shorts_audio_assets_present', to_regclass('public.shorts_audio_assets') IS NOT NULL,
  'audio_provider_constraints', (SELECT jsonb_agg(pg_get_constraintdef(oid))
    FROM pg_constraint WHERE conrelid = to_regclass('public.shorts_audio_assets')
    AND contype = 'c' AND conname LIKE '%provider%'),
  'rpc', (SELECT jsonb_agg(jsonb_build_object(
    'name', p.proname, 'identity', pg_get_function_identity_arguments(p.oid),
    'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    'service_execute', has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) ORDER BY p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname ~ '^(clips_|shorts_|youtube_)'),
  'buckets', (SELECT jsonb_agg(jsonb_build_object(
    'name', name, 'public', public, 'file_size_limit', file_size_limit
  ) ORDER BY name) FROM storage.buckets)
) AS schema_audit;
