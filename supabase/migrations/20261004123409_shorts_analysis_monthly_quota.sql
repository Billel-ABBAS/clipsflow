-- Meter long-form AI analysis by source seconds. Plan limits are provided by
-- the trusted server environment; there are intentionally no seeded values
-- because included usage is a product/pricing decision. Missing configuration
-- fails closed at the API boundary.

-- Preserve the user's original duration estimate separately because the
-- worker replaces source_duration_seconds with the verified media duration.
ALTER TABLE public.shorts_projects
  ADD COLUMN requested_source_duration_seconds integer;
UPDATE public.shorts_projects
SET requested_source_duration_seconds = source_duration_seconds
WHERE requested_source_duration_seconds IS NULL;
ALTER TABLE public.shorts_projects
  ADD CONSTRAINT shorts_projects_requested_duration_range
  CHECK (
    requested_source_duration_seconds IS NULL
    OR requested_source_duration_seconds BETWEEN 1200 AND 7200
  );

CREATE TABLE public.shorts_analysis_quota_usage (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  consumed_source_seconds bigint NOT NULL DEFAULT 0
    CHECK (consumed_source_seconds >= 0),
  reserved_source_seconds bigint NOT NULL DEFAULT 0
    CHECK (reserved_source_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_start),
  CONSTRAINT shorts_analysis_quota_period_start_month
    CHECK (period_start = date_trunc('month', period_start)::date)
);

CREATE TABLE public.shorts_analysis_quota_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  period_start date NOT NULL,
  source_duration_seconds integer NOT NULL
    CHECK (source_duration_seconds BETWEEN 1200 AND 7200),
  quota_limit_source_seconds integer NOT NULL
    CHECK (quota_limit_source_seconds >= 0),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'consumed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  CONSTRAINT shorts_analysis_quota_reservations_project_unique
    UNIQUE (project_id),
  CONSTRAINT shorts_analysis_quota_reservations_idempotency_unique
    UNIQUE (user_id, idempotency_key),
  CONSTRAINT shorts_analysis_quota_reservations_usage_fk
    FOREIGN KEY (user_id, period_start)
    REFERENCES public.shorts_analysis_quota_usage(user_id, period_start)
    ON DELETE CASCADE,
  CONSTRAINT shorts_analysis_quota_reservations_project_owner_fk
    FOREIGN KEY (project_id, user_id)
    REFERENCES public.shorts_projects(id, user_id)
    ON DELETE CASCADE
);

CREATE INDEX shorts_analysis_quota_reservations_active_idx
  ON public.shorts_analysis_quota_reservations(project_id, user_id)
  WHERE status = 'reserved';

ALTER TABLE public.shorts_analysis_quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_analysis_quota_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_analysis_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_analysis_quota_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shorts_analysis_quota_usage
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.shorts_analysis_quota_reservations
  FROM PUBLIC, anon, authenticated, service_role;

-- This transition hook is the single finalization path for a quota hold:
-- completed jobs consume verified source seconds; failed jobs release the
-- hold. It also covers terminal failures from expired worker leases.
CREATE OR REPLACE FUNCTION public.shorts_finalize_analysis_quota_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reservation public.shorts_analysis_quota_reservations%ROWTYPE;
  v_actual_source_seconds integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT reservation.* INTO v_reservation
    FROM public.shorts_analysis_quota_reservations AS reservation
    WHERE reservation.project_id = OLD.project_id
      AND reservation.user_id = OLD.user_id
      AND reservation.status = 'reserved'
    FOR UPDATE;
    IF FOUND THEN
      UPDATE public.shorts_analysis_quota_usage AS usage
      SET
        reserved_source_seconds = GREATEST(
          0,
          usage.reserved_source_seconds - v_reservation.source_duration_seconds
        ),
        updated_at = now()
      WHERE usage.user_id = v_reservation.user_id
        AND usage.period_start = v_reservation.period_start;
      UPDATE public.shorts_analysis_quota_reservations AS reservation
      SET status = 'released', finalized_at = now()
      WHERE reservation.id = v_reservation.id
        AND reservation.status = 'reserved';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status
    OR NEW.status NOT IN ('completed', 'failed') THEN
    RETURN NEW;
  END IF;

  SELECT reservation.* INTO v_reservation
  FROM public.shorts_analysis_quota_reservations AS reservation
  WHERE reservation.project_id = NEW.project_id
    AND reservation.user_id = NEW.user_id
    AND reservation.status = 'reserved'
  FOR UPDATE;
  -- Legacy jobs created before this migration have no reservation. They are
  -- allowed to finish without corrupting a quota row; new submissions use
  -- the quota-aware RPC below.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'completed' THEN
    SELECT project.source_duration_seconds INTO v_actual_source_seconds
    FROM public.shorts_projects AS project
    WHERE project.id = NEW.project_id
      AND project.user_id = NEW.user_id;
    IF v_actual_source_seconds IS NULL
      OR v_actual_source_seconds NOT BETWEEN 1200 AND 7200 THEN
      RAISE EXCEPTION 'analysis_quota_actual_duration_invalid'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.shorts_analysis_quota_usage AS usage
    SET
      reserved_source_seconds = usage.reserved_source_seconds
        - v_reservation.source_duration_seconds,
      consumed_source_seconds = usage.consumed_source_seconds
        + v_actual_source_seconds,
      updated_at = now()
    WHERE usage.user_id = v_reservation.user_id
      AND usage.period_start = v_reservation.period_start
      AND usage.reserved_source_seconds >= v_reservation.source_duration_seconds
      AND usage.consumed_source_seconds
        + usage.reserved_source_seconds
        - v_reservation.source_duration_seconds
        + v_actual_source_seconds <= v_reservation.quota_limit_source_seconds;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'analysis_quota_finalize_rejected'
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.shorts_analysis_quota_reservations AS reservation
    SET status = 'consumed', finalized_at = now()
    WHERE reservation.id = v_reservation.id
      AND reservation.status = 'reserved';
  ELSE
    UPDATE public.shorts_analysis_quota_usage AS usage
    SET
      reserved_source_seconds = usage.reserved_source_seconds
        - v_reservation.source_duration_seconds,
      updated_at = now()
    WHERE usage.user_id = v_reservation.user_id
      AND usage.period_start = v_reservation.period_start
      AND usage.reserved_source_seconds >= v_reservation.source_duration_seconds;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'analysis_quota_release_rejected'
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.shorts_analysis_quota_reservations AS reservation
    SET status = 'released', finalized_at = now()
    WHERE reservation.id = v_reservation.id
      AND reservation.status = 'reserved';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER shorts_analysis_quota_finalize_status
AFTER UPDATE OF status ON public.shorts_analysis_jobs
FOR EACH ROW
EXECUTE FUNCTION public.shorts_finalize_analysis_quota_reservation();

CREATE TRIGGER shorts_analysis_quota_release_deleted_job
AFTER DELETE ON public.shorts_analysis_jobs
FOR EACH ROW
EXECUTE FUNCTION public.shorts_finalize_analysis_quota_reservation();

-- Release a still-open reservation if the project itself is deleted and its
-- reservation cascades before the job deletion trigger can find it.
CREATE OR REPLACE FUNCTION public.shorts_release_deleted_analysis_quota_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'reserved' THEN
    UPDATE public.shorts_analysis_quota_usage AS usage
    SET
      reserved_source_seconds = GREATEST(
        0,
        usage.reserved_source_seconds - OLD.source_duration_seconds
      ),
      updated_at = now()
    WHERE usage.user_id = OLD.user_id
      AND usage.period_start = OLD.period_start;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER shorts_analysis_quota_release_deleted_reservation
AFTER DELETE ON public.shorts_analysis_quota_reservations
FOR EACH ROW
EXECUTE FUNCTION public.shorts_release_deleted_analysis_quota_reservation();

-- Replace the old submission path with a quota-aware RPC name. The old RPC
-- remains present for schema-cache/rollback safety but loses execute rights,
-- so older application code fails closed instead of bypassing quota.
REVOKE ALL ON FUNCTION public.shorts_submit_analysis_job(
  uuid, uuid, text, integer, text, boolean, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.shorts_submit_analysis_job_with_quota(
  p_user_id uuid,
  p_episode_id uuid,
  p_analysis_mode text,
  p_duration_seconds integer,
  p_user_instructions text,
  p_jev_shadow_consent boolean,
  p_idempotency_key uuid,
  p_quota_limit_source_seconds integer
)
RETURNS TABLE (
  project_id uuid,
  job_id uuid,
  status text,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.shorts_projects%ROWTYPE;
  v_job public.shorts_analysis_jobs%ROWTYPE;
  v_period_start date := pg_catalog.date_trunc(
    'month', pg_catalog.timezone('UTC', pg_catalog.now())
  )::date;
  v_reserved_user_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_episode_id IS NULL OR p_idempotency_key IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'invalid_request'::text;
    RETURN;
  END IF;
  IF p_quota_limit_source_seconds IS NULL OR p_quota_limit_source_seconds < 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'analysis_quota_unconfigured'::text;
    RETURN;
  END IF;
  IF p_analysis_mode NOT IN ('audio', 'audio_video') THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'invalid_analysis_mode'::text;
    RETURN;
  END IF;
  IF p_duration_seconds NOT BETWEEN 1200 AND 7200 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'duration_out_of_range'::text;
    RETURN;
  END IF;
  IF char_length(COALESCE(p_user_instructions, '')) > 1200 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'instructions_too_long'::text;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shorts-analysis:' || p_user_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  SELECT project.* INTO v_project
  FROM public.shorts_projects AS project
  WHERE project.user_id = p_user_id
    AND project.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_project.episode_id IS DISTINCT FROM p_episode_id
      OR v_project.analysis_mode IS DISTINCT FROM p_analysis_mode
      OR v_project.requested_source_duration_seconds IS DISTINCT FROM p_duration_seconds
      OR v_project.user_instructions IS DISTINCT FROM COALESCE(p_user_instructions, '')
      OR v_project.jev_shadow_consent IS DISTINCT FROM COALESCE(p_jev_shadow_consent, false) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'idempotency_conflict'::text;
      RETURN;
    END IF;
    SELECT job.* INTO v_job
    FROM public.shorts_analysis_jobs AS job
    WHERE job.project_id = v_project.id
      AND job.user_id = p_user_id;
    RETURN QUERY SELECT v_project.id, v_job.id, v_project.status, NULL::text;
    RETURN;
  END IF;

  IF p_duration_seconds > p_quota_limit_source_seconds THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'analysis_quota_exceeded'::text;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.episodes AS episode
  WHERE episode.id = p_episode_id
    AND episode.user_id = p_user_id
    AND episode.status = 'ready';
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'episode_not_ready'::text;
    RETURN;
  END IF;

  INSERT INTO public.shorts_analysis_quota_usage (
    user_id, period_start, reserved_source_seconds
  ) VALUES (
    p_user_id, v_period_start, p_duration_seconds
  )
  ON CONFLICT (user_id, period_start)
  DO UPDATE SET
    reserved_source_seconds = public.shorts_analysis_quota_usage.reserved_source_seconds
      + EXCLUDED.reserved_source_seconds,
    updated_at = pg_catalog.now()
  WHERE public.shorts_analysis_quota_usage.consumed_source_seconds
      + public.shorts_analysis_quota_usage.reserved_source_seconds
      + EXCLUDED.reserved_source_seconds <= p_quota_limit_source_seconds
  RETURNING user_id INTO v_reserved_user_id;
  IF NOT FOUND OR v_reserved_user_id IS DISTINCT FROM p_user_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'analysis_quota_exceeded'::text;
    RETURN;
  END IF;

  INSERT INTO public.shorts_projects (
    user_id,
    episode_id,
    analysis_mode,
    user_instructions,
    jev_shadow_consent,
    source_duration_seconds,
    requested_source_duration_seconds,
    status,
    idempotency_key
  ) VALUES (
    p_user_id,
    p_episode_id,
    p_analysis_mode,
    COALESCE(p_user_instructions, ''),
    COALESCE(p_jev_shadow_consent, false),
    p_duration_seconds,
    p_duration_seconds,
    'queued',
    p_idempotency_key
  )
  RETURNING * INTO v_project;

  INSERT INTO public.shorts_analysis_quota_reservations (
    user_id,
    project_id,
    idempotency_key,
    period_start,
    source_duration_seconds,
    quota_limit_source_seconds
  ) VALUES (
    p_user_id,
    v_project.id,
    p_idempotency_key,
    v_period_start,
    p_duration_seconds,
    p_quota_limit_source_seconds
  );

  INSERT INTO public.shorts_analysis_jobs (
    project_id,
    user_id,
    episode_id,
    payload
  ) VALUES (
    v_project.id,
    p_user_id,
    p_episode_id,
    pg_catalog.jsonb_build_object('version', 'longform-analysis-v1')
  )
  RETURNING * INTO v_job;

  RETURN QUERY SELECT v_project.id, v_job.id, v_project.status, NULL::text;
END;
$$;

-- Once the source is probed, adjust the hold to the verified duration before
-- any paid transcription/analysis calls. A creator cannot under-report the
-- source length to bypass the plan quota.
CREATE OR REPLACE FUNCTION public.shorts_adjust_analysis_quota(
  p_job_id uuid,
  p_lease_token uuid,
  p_actual_duration_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.shorts_analysis_jobs%ROWTYPE;
  v_reservation public.shorts_analysis_quota_reservations%ROWTYPE;
  v_delta integer;
BEGIN
  IF p_actual_duration_seconds NOT BETWEEN 1200 AND 7200 THEN
    RAISE EXCEPTION 'analysis_quota_actual_duration_invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT job.* INTO v_job
  FROM public.shorts_analysis_jobs AS job
  WHERE job.id = p_job_id
    AND job.status = 'processing'
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > pg_catalog.now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT reservation.* INTO v_reservation
  FROM public.shorts_analysis_quota_reservations AS reservation
  WHERE reservation.project_id = v_job.project_id
    AND reservation.user_id = v_job.user_id
    AND reservation.status = 'reserved'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.shorts_projects AS project
  WHERE project.id = v_job.project_id
    AND project.user_id = v_job.user_id
    AND project.status = 'transcribing'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_delta := p_actual_duration_seconds - v_reservation.source_duration_seconds;
  IF v_delta > 0 THEN
    UPDATE public.shorts_analysis_quota_usage AS usage
    SET
      reserved_source_seconds = usage.reserved_source_seconds + v_delta,
      updated_at = pg_catalog.now()
    WHERE usage.user_id = v_reservation.user_id
      AND usage.period_start = v_reservation.period_start
      AND usage.consumed_source_seconds
        + usage.reserved_source_seconds + v_delta
        <= v_reservation.quota_limit_source_seconds;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  ELSIF v_delta < 0 THEN
    UPDATE public.shorts_analysis_quota_usage AS usage
    SET
      reserved_source_seconds = usage.reserved_source_seconds + v_delta,
      updated_at = pg_catalog.now()
    WHERE usage.user_id = v_reservation.user_id
      AND usage.period_start = v_reservation.period_start
      AND usage.reserved_source_seconds >= -v_delta;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'analysis_quota_adjustment_rejected'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  UPDATE public.shorts_analysis_quota_reservations AS reservation
  SET source_duration_seconds = p_actual_duration_seconds
  WHERE reservation.id = v_reservation.id
    AND reservation.status = 'reserved';
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.shorts_finalize_analysis_quota_reservation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shorts_release_deleted_analysis_quota_reservation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.shorts_submit_analysis_job_with_quota(uuid, uuid, text, integer, text, boolean, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_submit_analysis_job_with_quota(uuid, uuid, text, integer, text, boolean, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.shorts_adjust_analysis_quota(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_adjust_analysis_quota(uuid, uuid, integer) TO service_role;

COMMENT ON TABLE public.shorts_analysis_quota_usage IS
  'Private monthly source-seconds consumed/reserved by each Shorts account; limits remain an operator-configured product policy.';
COMMENT ON TABLE public.shorts_analysis_quota_reservations IS
  'Private idempotent holds finalized by fenced worker job transitions; failed jobs release the hold and completed jobs consume verified source duration.';
COMMENT ON FUNCTION public.shorts_submit_analysis_job_with_quota(uuid, uuid, text, integer, text, boolean, uuid, integer) IS
  'Atomically reserves the configured monthly source-seconds quota and creates one idempotent long-form analysis project and queue job.';
COMMENT ON FUNCTION public.shorts_adjust_analysis_quota(uuid, uuid, integer) IS
  'Fenced adjustment of a Shorts analysis quota hold to the probed source duration before any paid provider calls.';
