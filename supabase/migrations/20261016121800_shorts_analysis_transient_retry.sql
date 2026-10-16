-- Keep short-lived provider, network, and Storage outages from immediately
-- terminalizing an otherwise valid long-form Shorts analysis job. A retry is
-- bounded by the existing two-claim policy and retains its quota reservation.
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
  v_now timestamptz := pg_catalog.now();
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

REVOKE ALL ON FUNCTION public.shorts_fail_or_retry_analysis_job(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_fail_or_retry_analysis_job(uuid, uuid, text, boolean)
  TO service_role;

COMMENT ON FUNCTION public.shorts_fail_or_retry_analysis_job(uuid, uuid, text, boolean) IS
  'Fenced terminal failure or one bounded requeue for explicitly classified transient analysis errors; retry keeps the monthly quota reservation.';
