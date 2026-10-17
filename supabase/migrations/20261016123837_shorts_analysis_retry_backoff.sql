-- Persist a short backoff for a transient upstream failure. This keeps a
-- healthy worker from immediately re-claiming the same job in a hot loop.
ALTER TABLE public.shorts_analysis_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS shorts_analysis_jobs_due_idx
  ON public.shorts_analysis_jobs(next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.shorts_fail_or_retry_analysis_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_message text,
  p_retryable boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.shorts_analysis_jobs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_error text := pg_catalog.left(
    COALESCE(p_error_message, 'analysis_failed'),
    400
  );
BEGIN
  SELECT job.* INTO v_job
  FROM public.shorts_analysis_jobs AS job
  WHERE job.id = p_job_id
    AND job.status = 'processing'
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > v_now
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF COALESCE(p_retryable, false) AND v_job.attempt_count < 2 THEN
    UPDATE public.shorts_projects AS project
    SET status = 'queued', error_message = NULL, completed_at = NULL,
        updated_at = v_now
    WHERE project.id = v_job.project_id
      AND project.user_id = v_job.user_id
      AND project.status IN ('queued', 'transcribing', 'analyzing');
    IF NOT FOUND THEN
      RETURN false;
    END IF;

    UPDATE public.shorts_analysis_jobs AS job
    SET status = 'pending',
        next_attempt_at = v_now + interval '30 seconds',
        claimed_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        error_message = 'analysis_retry_scheduled:' || v_error,
        completed_at = NULL
    WHERE job.id = v_job.id
      AND job.status = 'processing'
      AND job.lease_token = p_lease_token
      AND job.lease_expires_at > v_now;
    RETURN FOUND;
  END IF;

  UPDATE public.shorts_projects AS project
  SET status = 'failed',
      error_message = v_error,
      completed_at = v_now,
      updated_at = v_now
  WHERE project.id = v_job.project_id
    AND project.user_id = v_job.user_id
    AND project.status IN ('queued', 'transcribing', 'analyzing');

  UPDATE public.shorts_analysis_jobs AS job
  SET status = 'failed',
      error_message = v_error,
      completed_at = v_now,
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE job.id = v_job.id
    AND job.status = 'processing'
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > v_now;
  RETURN FOUND;
END;
$$;

-- Reuse the idempotent claim contract, adding only a due-time predicate to the
-- pending-job selection. Stale processing leases remain immediately recoverable.
CREATE OR REPLACE FUNCTION public.shorts_claim_analysis_job_idempotent(
  p_claim_request_id uuid,
  p_lease_seconds integer DEFAULT 1800
)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  user_id uuid,
  episode_id uuid,
  payload jsonb,
  status text,
  attempt_count integer,
  claimed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  error_message text,
  created_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz;
  v_prior public.shorts_analysis_claim_requests%ROWTYPE;
  v_stale public.shorts_analysis_jobs%ROWTYPE;
  v_claim public.shorts_analysis_jobs%ROWTYPE;
BEGIN
  IF p_claim_request_id IS NULL THEN
    RAISE EXCEPTION 'claim_request_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL
    OR p_lease_seconds < 300
    OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds_out_of_range' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shorts-analysis-claim:' || p_claim_request_id::text,
      0
    )
  );
  v_now := pg_catalog.clock_timestamp();

  SELECT request.* INTO v_prior
  FROM public.shorts_analysis_claim_requests AS request
  WHERE request.request_id = p_claim_request_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_prior.outcome = 'empty' THEN
      RETURN;
    END IF;
    SELECT job.* INTO v_claim
    FROM public.shorts_analysis_jobs AS job
    WHERE job.id = v_prior.job_id
      AND job.status = 'processing'
      AND job.lease_token = v_prior.lease_token
      AND job.lease_expires_at > v_now;
    IF FOUND THEN
      RETURN QUERY SELECT
        v_claim.id, v_claim.project_id, v_claim.user_id, v_claim.episode_id,
        v_claim.payload, v_claim.status, v_claim.attempt_count,
        v_claim.claimed_at, v_claim.lease_token, v_claim.lease_expires_at,
        v_claim.error_message, v_claim.created_at, v_claim.completed_at;
    END IF;
    RETURN;
  END IF;

  DELETE FROM public.shorts_analysis_claim_requests AS request
  WHERE request.request_id IN (
    SELECT expired.request_id
    FROM public.shorts_analysis_claim_requests AS expired
    WHERE expired.created_at < v_now - interval '7 days'
      OR (
        expired.outcome = 'empty'
        AND expired.created_at < v_now - interval '15 minutes'
      )
    ORDER BY expired.created_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  );

  FOR v_stale IN
    SELECT job.*
    FROM public.shorts_analysis_jobs AS job
    WHERE job.status = 'processing'
      AND (
        job.lease_expires_at IS NULL
        OR job.lease_expires_at <= v_now
      )
    ORDER BY job.lease_expires_at ASC NULLS FIRST
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_stale.attempt_count < 2 THEN
      UPDATE public.shorts_analysis_jobs AS job
      SET status = 'pending',
          next_attempt_at = v_now,
          claimed_at = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          error_message = 'worker_interrupted_retrying'
      WHERE job.id = v_stale.id;
      UPDATE public.shorts_projects AS project
      SET status = 'queued', error_message = NULL
      WHERE project.id = v_stale.project_id
        AND project.user_id = v_stale.user_id
        AND project.status IN ('transcribing', 'analyzing');
    ELSE
      UPDATE public.shorts_analysis_jobs AS job
      SET status = 'failed',
          error_message = 'worker_interrupted',
          completed_at = v_now,
          lease_token = NULL,
          lease_expires_at = NULL
      WHERE job.id = v_stale.id;
      UPDATE public.shorts_projects AS project
      SET status = 'failed',
          error_message = 'worker_interrupted',
          completed_at = v_now
      WHERE project.id = v_stale.project_id
        AND project.user_id = v_stale.user_id
        AND project.status IN ('queued', 'transcribing', 'analyzing');
    END IF;
  END LOOP;

  v_now := pg_catalog.clock_timestamp();
  SELECT job.* INTO v_claim
  FROM public.shorts_analysis_jobs AS job
  WHERE job.status = 'pending'
    AND job.next_attempt_at <= v_now
  ORDER BY job.next_attempt_at ASC, job.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    INSERT INTO public.shorts_analysis_claim_requests (request_id, outcome)
    VALUES (p_claim_request_id, 'empty');
    RETURN;
  END IF;

  UPDATE public.shorts_projects AS project
  SET status = 'transcribing', error_message = NULL
  WHERE project.id = v_claim.project_id
    AND project.user_id = v_claim.user_id
    AND project.status = 'queued';

  IF NOT FOUND THEN
    UPDATE public.shorts_analysis_jobs AS job
    SET status = 'failed', error_message = 'project_not_queueable', completed_at = v_now
    WHERE job.id = v_claim.id;
    INSERT INTO public.shorts_analysis_claim_requests (request_id, job_id, outcome)
    VALUES (p_claim_request_id, v_claim.id, 'empty');
    RETURN;
  END IF;

  UPDATE public.shorts_analysis_jobs AS job
  SET status = 'processing',
      attempt_count = job.attempt_count + 1,
      claimed_at = v_now,
      lease_token = pg_catalog.gen_random_uuid(),
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      error_message = NULL
  WHERE job.id = v_claim.id
  RETURNING * INTO v_claim;

  INSERT INTO public.shorts_analysis_claim_requests (
    request_id, job_id, outcome, lease_token
  ) VALUES (
    p_claim_request_id, v_claim.id, 'claimed', v_claim.lease_token
  );

  RETURN QUERY SELECT
    v_claim.id, v_claim.project_id, v_claim.user_id, v_claim.episode_id,
    v_claim.payload, v_claim.status, v_claim.attempt_count,
    v_claim.claimed_at, v_claim.lease_token, v_claim.lease_expires_at,
    v_claim.error_message, v_claim.created_at, v_claim.completed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.shorts_fail_or_retry_analysis_job(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_fail_or_retry_analysis_job(uuid, uuid, text, boolean)
  TO service_role;
REVOKE ALL ON FUNCTION public.shorts_claim_analysis_job_idempotent(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_claim_analysis_job_idempotent(uuid, integer)
  TO service_role;

COMMENT ON FUNCTION public.shorts_fail_or_retry_analysis_job(uuid, uuid, text, boolean) IS
  'Fenced terminal failure or one bounded requeue after a persisted 30-second delay for transient errors; retry keeps the monthly quota reservation.';
