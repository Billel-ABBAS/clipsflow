-- The rollout flag is only an operator gate. This server-only heartbeat is
-- the runtime evidence that the dedicated analysis worker can reach Supabase.
BEGIN;

CREATE TABLE public.shorts_analysis_worker_health (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton IS TRUE),
  last_heartbeat_at timestamptz NOT NULL
);

ALTER TABLE public.shorts_analysis_worker_health ENABLE ROW LEVEL SECURITY;

-- No application/API role can read or mutate this internal health record.
-- The SECURITY DEFINER RPCs below expose only a heartbeat write and one bool.
REVOKE ALL ON TABLE public.shorts_analysis_worker_health
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.shorts_record_analysis_worker_heartbeat()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.shorts_analysis_worker_health (
    singleton,
    last_heartbeat_at
  )
  VALUES (true, pg_catalog.clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE
    SET last_heartbeat_at = EXCLUDED.last_heartbeat_at;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.shorts_is_analysis_worker_healthy()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_last_heartbeat_at timestamptz;
BEGIN
  SELECT health.last_heartbeat_at
    INTO v_last_heartbeat_at
  FROM public.shorts_analysis_worker_health AS health
  WHERE health.singleton IS TRUE;

  RETURN v_last_heartbeat_at IS NOT NULL
    AND v_last_heartbeat_at <= v_now
    AND v_last_heartbeat_at > v_now - INTERVAL '15 minutes';
END;
$function$;

REVOKE ALL ON FUNCTION public.shorts_record_analysis_worker_heartbeat()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shorts_is_analysis_worker_healthy()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shorts_record_analysis_worker_heartbeat()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.shorts_is_analysis_worker_healthy()
  TO service_role;

COMMENT ON TABLE public.shorts_analysis_worker_health IS
  'Private runtime heartbeat for the Shorts analysis worker; access only through service-role RPCs.';
COMMENT ON FUNCTION public.shorts_record_analysis_worker_heartbeat() IS
  'Records a database-clock heartbeat for the Shorts analysis worker.';
COMMENT ON FUNCTION public.shorts_is_analysis_worker_healthy() IS
  'Returns true only when the Shorts analysis worker heartbeat is no older than 15 minutes.';

COMMIT;
