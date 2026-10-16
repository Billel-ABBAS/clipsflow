-- Make a bounded worker retry safe when the database commits a claim but the
-- PostgREST response is lost. The request ledger is private and retained for
-- seven days; job deletion only nulls the reference so a replay cannot claim
-- a different job during the retry window.
CREATE TABLE public.shorts_analysis_claim_requests (
  request_id uuid PRIMARY KEY,
  job_id uuid REFERENCES public.shorts_analysis_jobs(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('claimed', 'empty')),
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shorts_analysis_claim_requests_outcome_lease_check
    CHECK (
      (outcome = 'claimed' AND lease_token IS NOT NULL)
      OR (outcome = 'empty' AND lease_token IS NULL)
    ),
  CONSTRAINT shorts_analysis_claim_requests_job_lease_unique
    UNIQUE (job_id, lease_token)
);

CREATE INDEX shorts_analysis_claim_requests_created_idx
  ON public.shorts_analysis_claim_requests(created_at, request_id);
CREATE INDEX shorts_analysis_claim_requests_job_idx
  ON public.shorts_analysis_claim_requests(job_id)
  WHERE job_id IS NOT NULL;

ALTER TABLE public.shorts_analysis_claim_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_analysis_claim_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shorts_analysis_claim_requests
  FROM PUBLIC, anon, authenticated, service_role;

-- Keep the legacy RPC signature available during a rolling deployment. The
-- new name avoids PostgREST overload ambiguity for the idempotent worker.
CREATE FUNCTION public.shorts_claim_analysis_job_idempotent(
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

  -- Serializes duplicate HTTP submissions before checking the durable key.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shorts-analysis-claim:' || p_claim_request_id::text,
      0
    )
  );
  -- Use a fresh timestamp after lock contention, not the transaction start
  -- time, when deciding whether an existing lease is still live.
  v_now := pg_catalog.clock_timestamp();

  SELECT request.* INTO v_prior
  FROM public.shorts_analysis_claim_requests AS request
  WHERE request.request_id = p_claim_request_id
  FOR UPDATE;
  IF FOUND THEN
    -- Empty is a durable answer too. Replaying an idle or non-queueable
    -- request must not silently consume a job that arrived later.
    IF v_prior.outcome = 'empty' THEN
      RETURN;
    END IF;
    -- Replay only the exact still-live lease created by this request. A
    -- completed, deleted, expired, or superseded claim is never reassigned.
    SELECT job.* INTO v_claim
    FROM public.shorts_analysis_jobs AS job
    WHERE job.id = v_prior.job_id
      AND job.status = 'processing'
      AND job.lease_token = v_prior.lease_token
      AND job.lease_expires_at > v_now;
    IF FOUND THEN
      RETURN QUERY SELECT
        v_claim.id,
        v_claim.project_id,
        v_claim.user_id,
        v_claim.episode_id,
        v_claim.payload,
        v_claim.status,
        v_claim.attempt_count,
        v_claim.claimed_at,
        v_claim.lease_token,
        v_claim.lease_expires_at,
        v_claim.error_message,
        v_claim.created_at,
        v_claim.completed_at;
    END IF;
    RETURN;
  END IF;

  -- Bound ledger growth. Empty-poll tombstones only need to outlive the bounded
  -- transport retry; successful claims remain recorded for the full seven days.
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
      -- Older RPC calls accepted an explicit NULL lease duration. Such jobs
      -- cannot be renewed or fenced, so treat them as stale during recovery.
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
      SET
        status = 'pending',
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
      SET
        status = 'failed',
        error_message = 'worker_interrupted',
        completed_at = v_now,
        lease_token = NULL,
        lease_expires_at = NULL
      WHERE job.id = v_stale.id;
      UPDATE public.shorts_projects AS project
      SET
        status = 'failed',
        error_message = 'worker_interrupted',
        completed_at = v_now
      WHERE project.id = v_stale.project_id
        AND project.user_id = v_stale.user_id
        AND project.status IN ('queued', 'transcribing', 'analyzing');
    END IF;
  END LOOP;

  -- The stale-lease sweep is bounded, but it can still take long enough for
  -- the timestamp captured after the advisory lock to become outdated.
  v_now := pg_catalog.clock_timestamp();

  SELECT job.* INTO v_claim
  FROM public.shorts_analysis_jobs AS job
  WHERE job.status = 'pending'
  ORDER BY job.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    INSERT INTO public.shorts_analysis_claim_requests (
      request_id,
      outcome
    ) VALUES (
      p_claim_request_id,
      'empty'
    );
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
    INSERT INTO public.shorts_analysis_claim_requests (
      request_id,
      job_id,
      outcome
    ) VALUES (
      p_claim_request_id,
      v_claim.id,
      'empty'
    );
    RETURN;
  END IF;

  UPDATE public.shorts_analysis_jobs AS job
  SET
    status = 'processing',
    attempt_count = job.attempt_count + 1,
    claimed_at = v_now,
    lease_token = pg_catalog.gen_random_uuid(),
    lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
    error_message = NULL
  WHERE job.id = v_claim.id
  RETURNING * INTO v_claim;

  INSERT INTO public.shorts_analysis_claim_requests (
    request_id,
    job_id,
    outcome,
    lease_token
  ) VALUES (
    p_claim_request_id,
    v_claim.id,
    'claimed',
    v_claim.lease_token
  );

  RETURN QUERY SELECT
    v_claim.id,
    v_claim.project_id,
    v_claim.user_id,
    v_claim.episode_id,
    v_claim.payload,
    v_claim.status,
    v_claim.attempt_count,
    v_claim.claimed_at,
    v_claim.lease_token,
    v_claim.lease_expires_at,
    v_claim.error_message,
    v_claim.created_at,
    v_claim.completed_at;
END;
$$;

-- Keep the legacy PostgREST RPC compatible for old workers, but route it
-- through the validated implementation so NULL lease values cannot create
-- unbounded processing jobs during a rolling deployment.
CREATE OR REPLACE FUNCTION public.shorts_claim_analysis_job(
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
BEGIN
  IF p_lease_seconds IS NULL
    OR p_lease_seconds < 300
    OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds_out_of_range' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.shorts_claim_analysis_job_idempotent(
    pg_catalog.gen_random_uuid(),
    p_lease_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shorts_claim_analysis_job_idempotent(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shorts_claim_analysis_job_idempotent(uuid, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.shorts_claim_analysis_job(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_claim_analysis_job(integer)
  TO service_role;

COMMENT ON TABLE public.shorts_analysis_claim_requests IS
  'Private claim idempotency ledger; empty poll tombstones are short-lived and claimed leases are retained for seven days.';
COMMENT ON FUNCTION public.shorts_claim_analysis_job_idempotent(uuid, integer) IS
  'Claims one analysis job with a fenced lease and replays the same live lease for a repeated claim request id.';
COMMENT ON FUNCTION public.shorts_claim_analysis_job(integer) IS
  'Backward-compatible claim RPC; validates lease duration and delegates to the idempotent claim implementation.';
