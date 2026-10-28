-- A controlled smoke worker may claim exactly one explicitly identified job.
-- This function intentionally does not sweep expired leases or requeue jobs.
CREATE OR REPLACE FUNCTION public.shorts_claim_analysis_targeted(
  p_claim_request_id uuid,
  p_job_id uuid,
  p_user_id uuid,
  p_lease_seconds integer DEFAULT 1800
)
RETURNS TABLE (
  id uuid, project_id uuid, user_id uuid, episode_id uuid, payload jsonb,
  status text, attempt_count integer, claimed_at timestamptz, lease_token uuid,
  lease_expires_at timestamptz, error_message text, created_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz;
  v_prior public.shorts_analysis_claim_requests%ROWTYPE;
  v_job public.shorts_analysis_jobs%ROWTYPE;
BEGIN
  IF p_claim_request_id IS NULL OR p_job_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'targeted_claim_identifiers_required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 300 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds_out_of_range' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shorts-analysis-claim:' || p_claim_request_id::text, 0)
  );
  v_now := pg_catalog.clock_timestamp();
  SELECT request.* INTO v_prior
  FROM public.shorts_analysis_claim_requests AS request
  WHERE request.request_id = p_claim_request_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_prior.outcome <> 'claimed' OR v_prior.job_id IS DISTINCT FROM p_job_id THEN
      RETURN;
    END IF;
    SELECT job.* INTO v_job FROM public.shorts_analysis_jobs AS job
    WHERE job.id = p_job_id AND job.user_id = p_user_id
      AND job.status = 'processing' AND job.lease_token = v_prior.lease_token
      AND job.lease_expires_at > v_now;
    IF FOUND THEN
      RETURN QUERY SELECT v_job.id, v_job.project_id, v_job.user_id, v_job.episode_id,
        v_job.payload, v_job.status, v_job.attempt_count, v_job.claimed_at,
        v_job.lease_token, v_job.lease_expires_at, v_job.error_message,
        v_job.created_at, v_job.completed_at;
    END IF;
    RETURN;
  END IF;

  -- Match the ordinary claim's bounded ledger retention. This only removes
  -- expired request records, never jobs or active leases.
  DELETE FROM public.shorts_analysis_claim_requests AS request
  WHERE request.request_id IN (
    SELECT expired.request_id
    FROM public.shorts_analysis_claim_requests AS expired
    WHERE expired.created_at < v_now - interval '7 days'
      OR (expired.outcome = 'empty' AND expired.created_at < v_now - interval '15 minutes')
    ORDER BY expired.created_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  );

  SELECT job.* INTO v_job FROM public.shorts_analysis_jobs AS job
  WHERE job.id = p_job_id AND job.user_id = p_user_id
    AND job.status = 'pending' AND job.attempt_count = 0
    AND job.next_attempt_at <= v_now
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    INSERT INTO public.shorts_analysis_claim_requests (request_id, outcome)
    VALUES (p_claim_request_id, 'empty');
    RETURN;
  END IF;

  UPDATE public.shorts_projects AS project
  SET status = 'transcribing', error_message = NULL
  WHERE project.id = v_job.project_id AND project.user_id = p_user_id
    AND project.status = 'queued';
  IF NOT FOUND THEN
    INSERT INTO public.shorts_analysis_claim_requests (request_id, outcome)
    VALUES (p_claim_request_id, 'empty');
    RETURN;
  END IF;

  UPDATE public.shorts_analysis_jobs AS job
  SET status = 'processing', attempt_count = 1, claimed_at = v_now,
      lease_token = pg_catalog.gen_random_uuid(),
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      error_message = NULL
  WHERE job.id = v_job.id
  RETURNING job.* INTO v_job;

  INSERT INTO public.shorts_analysis_claim_requests (request_id, job_id, outcome, lease_token)
  VALUES (p_claim_request_id, v_job.id, 'claimed', v_job.lease_token);
  RETURN QUERY SELECT v_job.id, v_job.project_id, v_job.user_id, v_job.episode_id,
    v_job.payload, v_job.status, v_job.attempt_count, v_job.claimed_at,
    v_job.lease_token, v_job.lease_expires_at, v_job.error_message,
    v_job.created_at, v_job.completed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.shorts_claim_analysis_targeted(uuid, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_claim_analysis_targeted(uuid, uuid, uuid, integer)
  TO service_role;
