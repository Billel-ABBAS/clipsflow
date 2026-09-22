-- Railway render worker: fenced leases and atomic terminal transitions.
--
-- This migration is deliberately repository-only until an authorised
-- staging Supabase project has been named and verified.  Every RPC below is
-- service_role-only: browser clients retain the existing public submit and
-- status APIs, but cannot claim, renew, complete, fail, or refund jobs.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_applied_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_jobs_render_lease_recovery
  ON public.jobs (type, status, lease_expires_at, created_at)
  WHERE type = 'render' AND status = 'processing';

-- During cut-over no old in-flight renderer may retain an un-fenced claim.
-- The release procedure disables the old Vercel cron before this migration is
-- applied in production; returning unfinished work to pending is therefore
-- safe and preserves the original quota reservation.
UPDATE public.jobs
SET
  status = 'pending',
  claimed_at = NULL,
  lease_token = NULL,
  lease_expires_at = NULL,
  error_message = NULL
WHERE type = 'render' AND status = 'processing';

UPDATE public.clips AS clip
SET status = 'pending'
FROM public.jobs AS job
WHERE job.type = 'render'
  AND job.status = 'pending'
  AND job.clip_id = clip.id
  AND clip.status = 'processing';

-- Claims one render at a time.  An expired lease receives one fenced retry;
-- after the second expired lease the same transaction marks the clip failed
-- and refunds its reserved seconds exactly once.  The storage object name is
-- later derived from lease_token, so a late process cannot overwrite a newer
-- attempt even before the final DB fence rejects it.
CREATE OR REPLACE FUNCTION public.clips_claim_render_job(
  p_lease_seconds integer DEFAULT 600
)
RETURNS TABLE (
  id uuid,
  type text,
  user_id uuid,
  episode_id uuid,
  clip_id uuid,
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
  v_now timestamptz := now();
  v_stale public.jobs%ROWTYPE;
  v_claim public.jobs%ROWTYPE;
  v_refund_user_id uuid;
  v_refund_seconds integer;
  v_refunded boolean;
BEGIN
  IF p_lease_seconds < 120 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease_seconds_out_of_range' USING ERRCODE = '22023';
  END IF;

  -- Recover every expired render lease before choosing new work.  `FOR UPDATE
  -- SKIP LOCKED` makes simultaneous Railway invocations harmless.
  FOR v_stale IN
    SELECT *
    FROM public.jobs
    WHERE type = 'render'
      AND status = 'processing'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= v_now
    ORDER BY lease_expires_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_stale.attempt_count < 2 THEN
      UPDATE public.jobs
      SET
        status = 'pending',
        claimed_at = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        error_message = 'worker_interrupted_retrying'
      WHERE id = v_stale.id;

      UPDATE public.clips
      SET status = 'pending'
      WHERE id = v_stale.clip_id
        AND status = 'processing';
    ELSE
      v_refund_user_id := NULL;
      v_refund_seconds := NULL;
      UPDATE public.clips
      SET
        status = 'failed',
        error_message = 'worker_interrupted',
        completed_at = v_now
      WHERE id = v_stale.clip_id
        AND status IN ('pending', 'processing')
      RETURNING user_id, duration_seconds
        INTO v_refund_user_id, v_refund_seconds;
      v_refunded := FOUND;

      IF v_refunded AND v_refund_seconds > 0 THEN
        UPDATE public.profiles
        SET clip_seconds_used_this_month = GREATEST(
          0,
          clip_seconds_used_this_month - v_refund_seconds
        )
        WHERE id = v_refund_user_id;
      END IF;

      UPDATE public.jobs
      SET
        status = 'failed',
        error_message = 'worker_interrupted',
        completed_at = v_now,
        lease_token = NULL,
        lease_expires_at = NULL,
        refund_applied_at = CASE WHEN v_refunded THEN v_now ELSE NULL END
      WHERE id = v_stale.id;
    END IF;
  END LOOP;

  SELECT * INTO v_claim
  FROM public.jobs
  WHERE type = 'render'
    AND status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.clips
  SET status = 'processing'
  WHERE id = v_claim.clip_id
    AND status = 'pending';

  -- A deleted or terminal clip is never rendered.  Mark only the bad job;
  -- any already terminal clip keeps its authoritative state and quota.
  IF NOT FOUND THEN
    UPDATE public.jobs
    SET
      status = 'failed',
      error_message = 'clip_not_pending',
      completed_at = v_now
    WHERE id = v_claim.id;
    RETURN;
  END IF;

  UPDATE public.jobs
  SET
    status = 'processing',
    attempt_count = attempt_count + 1,
    claimed_at = v_now,
    lease_token = gen_random_uuid(),
    lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
    error_message = NULL
  WHERE id = v_claim.id
  RETURNING * INTO v_claim;

  RETURN QUERY
  SELECT
    v_claim.id,
    v_claim.type,
    v_claim.user_id,
    v_claim.episode_id,
    v_claim.clip_id,
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

CREATE OR REPLACE FUNCTION public.clips_renew_render_lease(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_lease_seconds < 120 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease_seconds_out_of_range' USING ERRCODE = '22023';
  END IF;

  UPDATE public.jobs
  SET lease_expires_at = v_now + make_interval(secs => p_lease_seconds)
  WHERE id = p_job_id
    AND type = 'render'
    AND status = 'processing'
    AND lease_token = p_lease_token
    AND lease_expires_at > v_now;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.clips_complete_render_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_video_url text,
  p_video_storage_path text,
  p_captions_vtt_url text,
  p_captions_vtt_storage_path text,
  p_cost_usd numeric,
  p_score smallint,
  p_hook_text text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
    AND type = 'render'
    AND status = 'processing'
    AND lease_token = p_lease_token
    AND lease_expires_at > v_now
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.clips
  SET
    status = 'completed',
    video_url = p_video_url,
    video_storage_path = p_video_storage_path,
    captions_vtt_url = p_captions_vtt_url,
    captions_vtt_storage_path = p_captions_vtt_storage_path,
    cost_usd = p_cost_usd,
    score = p_score,
    hook_text = p_hook_text,
    error_message = NULL,
    completed_at = v_now
  WHERE id = v_job.clip_id
    AND user_id = v_job.user_id
    AND status IN ('pending', 'processing');

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.jobs
  SET
    status = 'completed',
    completed_at = v_now,
    lease_token = NULL,
    lease_expires_at = NULL,
    error_message = NULL
  WHERE id = v_job.id;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.clips_fail_render_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_now timestamptz := now();
  v_refund_user_id uuid;
  v_refund_seconds integer;
BEGIN
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
    AND type = 'render'
    AND status = 'processing'
    AND lease_token = p_lease_token
    AND lease_expires_at > v_now
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.clips
  SET
    status = 'failed',
    error_message = left(COALESCE(p_error_message, 'render_failed'), 400),
    completed_at = v_now
  WHERE id = v_job.clip_id
    AND user_id = v_job.user_id
    AND status IN ('pending', 'processing')
  RETURNING user_id, duration_seconds
    INTO v_refund_user_id, v_refund_seconds;

  IF FOUND AND v_refund_seconds > 0 THEN
    UPDATE public.profiles
    SET clip_seconds_used_this_month = GREATEST(
      0,
      clip_seconds_used_this_month - v_refund_seconds
    )
    WHERE id = v_refund_user_id;
  END IF;

  UPDATE public.jobs
  SET
    status = 'failed',
    error_message = left(COALESCE(p_error_message, 'render_failed'), 400),
    completed_at = v_now,
    lease_token = NULL,
    lease_expires_at = NULL,
    refund_applied_at = CASE WHEN v_refund_user_id IS NOT NULL THEN v_now ELSE NULL END
  WHERE id = v_job.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.clips_claim_render_job(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clips_claim_render_job(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_claim_render_job(integer) TO service_role;

REVOKE ALL ON FUNCTION public.clips_renew_render_lease(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clips_renew_render_lease(uuid, uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_renew_render_lease(uuid, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.clips_complete_render_job(uuid, uuid, text, text, text, text, numeric, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clips_complete_render_job(uuid, uuid, text, text, text, text, numeric, smallint, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_complete_render_job(uuid, uuid, text, text, text, text, numeric, smallint, text) TO service_role;

REVOKE ALL ON FUNCTION public.clips_fail_render_job(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clips_fail_render_job(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_fail_render_job(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.clips_claim_render_job(integer) IS
  'Claims at most one render with a fenced renewable lease. Recovers an expired worker once, then refunds exactly once on terminal interruption.';
COMMENT ON FUNCTION public.clips_complete_render_job(uuid, uuid, text, text, text, text, numeric, smallint, text) IS
  'Atomically stores a fenced render result. A stale lease returns false and cannot overwrite a newer result.';
COMMENT ON FUNCTION public.clips_fail_render_job(uuid, uuid, text) IS
  'Atomically fails a fenced render and applies its reserved quota refund at most once.';
