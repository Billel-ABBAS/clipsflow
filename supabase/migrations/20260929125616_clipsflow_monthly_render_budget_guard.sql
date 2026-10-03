-- ClipsFlow render budget guard.
--
-- This is intentionally scoped to clip admission: it never changes a Railway
-- workspace limit, so Calpyra-AI and Cal-Halal cannot be paused by this guard.
-- The cap is opt-in and starts disabled.  It is a conservative estimate of
-- clip COGS, not an invoice or a replacement for Railway usage monitoring.

-- This may be applied manually to an already aligned staging database before
-- its Supabase CLI migration history is repaired.  Keep the DDL replay-safe:
-- the table shape is still asserted by the migration tests and every mutable
-- object below is replaced or granted explicitly.
CREATE TABLE IF NOT EXISTS public.clips_budget_guard (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  monthly_budget_usd numeric(10, 4),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd > 0)
);

ALTER TABLE public.clips_budget_guard ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clips_budget_guard FORCE ROW LEVEL SECURITY;

-- No browser role can read, alter, or infer the operational cap directly.
REVOKE ALL ON TABLE public.clips_budget_guard FROM PUBLIC;
REVOKE ALL ON TABLE public.clips_budget_guard FROM anon, authenticated;

INSERT INTO public.clips_budget_guard (singleton, enabled, monthly_budget_usd)
VALUES (true, false, NULL)
ON CONFLICT (singleton) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_clips_completed_monthly_cost
  ON public.clips (completed_at)
  WHERE status = 'completed' AND cost_usd IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_render_budget_active
  ON public.jobs (type, status)
  WHERE type = 'render' AND status IN ('pending', 'processing');

-- Keep the original public RPC signature.  The cap is configured only in the
-- database, so no browser-supplied request parameter can raise or bypass it.
-- A transaction-scoped advisory lock serializes all budget admissions.  The
-- completed amount plus every pending/processing reservation is checked
-- before quota is reserved or rows are created.
CREATE OR REPLACE FUNCTION public.clips_submit_job(
  p_user_id uuid,
  p_episode_id uuid,
  p_start_seconds integer,
  p_end_seconds integer,
  p_style_key text,
  p_aspect_ratio text,
  p_language text,
  p_customizations jsonb,
  p_overlays jsonb
)
RETURNS TABLE (
  clip_id uuid,
  job_id uuid,
  remaining_seconds integer,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan text;
  v_limit integer;
  v_used integer;
  v_duration integer;
  v_clip_id uuid;
  v_job_id uuid;
  v_budget_enabled boolean := false;
  v_monthly_budget_usd numeric(10, 4);
  v_completed_cost_usd numeric := 0;
  v_reserved_cost_usd numeric := 0;
  v_estimated_cost_usd numeric(10, 6);
  v_month_start timestamptz := pg_catalog.date_trunc('month', now());
BEGIN
  v_duration := p_end_seconds - p_start_seconds;
  IF p_start_seconds < 0 OR v_duration <= 0 OR v_duration > 180 THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::uuid, 0, 'invalid_input'::text;
    RETURN;
  END IF;

  -- Mirrors src/lib/clips/cost.ts: Whisper + storage/egress + compute.
  -- Store the reservation even while the guard is disabled, so an operator
  -- enabling it later still accounts for render jobs already in flight.
  v_estimated_cost_usd := pg_catalog.round(
    (v_duration * 0.0000161::numeric) + 0.002775::numeric,
    6
  );

  SELECT guard.enabled, guard.monthly_budget_usd
    INTO v_budget_enabled, v_monthly_budget_usd
  FROM public.clips_budget_guard AS guard
  WHERE guard.singleton = true;

  IF COALESCE(v_budget_enabled, false) THEN
    -- One lock across all users is deliberate: this is a service-wide ceiling,
    -- and a per-user lock would allow simultaneous requests to overshoot it.
    PERFORM pg_catalog.pg_advisory_xact_lock(974301, 119220);

    -- Re-read after taking the lock, so an operator changing the gate cannot
    -- race an admission in the same transaction.
    SELECT guard.enabled, guard.monthly_budget_usd
      INTO v_budget_enabled, v_monthly_budget_usd
    FROM public.clips_budget_guard AS guard
    WHERE guard.singleton = true;

    IF NOT COALESCE(v_budget_enabled, false) THEN
      NULL;
    ELSIF v_monthly_budget_usd IS NULL OR v_monthly_budget_usd <= 0 THEN
      RETURN QUERY
        SELECT NULL::uuid, NULL::uuid, 0, 'budget_unconfigured'::text;
      RETURN;
    ELSE
      -- Completed clips use their persisted value; in-flight work keeps this
      -- reservation until it succeeds or terminally fails.
      SELECT COALESCE(SUM(COALESCE(clip.cost_usd, 0)), 0)
        INTO v_completed_cost_usd
      FROM public.clips AS clip
      WHERE clip.status = 'completed'
        AND clip.completed_at >= v_month_start;

      SELECT COALESCE(SUM(
        CASE
          WHEN jsonb_typeof(job.payload -> 'estimated_cost_usd') = 'number'
            THEN (job.payload ->> 'estimated_cost_usd')::numeric
          ELSE 0
        END
      ), 0)
        INTO v_reserved_cost_usd
      FROM public.jobs AS job
      WHERE job.type = 'render'
        AND job.status IN ('pending', 'processing');

      IF v_completed_cost_usd + v_reserved_cost_usd + v_estimated_cost_usd
          > v_monthly_budget_usd THEN
        RETURN QUERY
          SELECT NULL::uuid, NULL::uuid, 0, 'budget_exceeded'::text;
        RETURN;
      END IF;
    END IF;
  END IF;

  SELECT profile.plan, profile.clip_seconds_used_this_month
    INTO v_plan, v_used
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::uuid, 0, 'profile_not_found'::text;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.episodes AS episode
  WHERE episode.id = p_episode_id
    AND episode.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::uuid, 0, 'episode_not_found'::text;
    RETURN;
  END IF;

  v_limit := CASE v_plan
    WHEN 'free' THEN 60
    WHEN 'solo' THEN 480
    WHEN 'pro' THEN 1800
    WHEN 'studio' THEN 3600
    ELSE 0
  END;

  IF v_used + v_duration > v_limit THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::uuid, GREATEST(0, v_limit - v_used), 'quota_exceeded'::text;
    RETURN;
  END IF;

  UPDATE public.profiles
  SET clip_seconds_used_this_month = clip_seconds_used_this_month + v_duration
  WHERE id = p_user_id
    AND clip_seconds_used_this_month + v_duration <= v_limit
  RETURNING clip_seconds_used_this_month INTO v_used;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::uuid, 0, 'quota_exceeded'::text;
    RETURN;
  END IF;

  INSERT INTO public.clips (
    episode_id,
    user_id,
    start_seconds,
    end_seconds,
    style_key,
    aspect_ratio,
    language,
    customizations,
    overlays,
    status
  ) VALUES (
    p_episode_id,
    p_user_id,
    p_start_seconds,
    p_end_seconds,
    p_style_key,
    p_aspect_ratio,
    p_language,
    COALESCE(p_customizations, '{}'::jsonb),
    COALESCE(p_overlays, '[]'::jsonb),
    'pending'
  )
  RETURNING id INTO v_clip_id;

  INSERT INTO public.jobs (
    type,
    user_id,
    episode_id,
    clip_id,
    payload,
    status
  ) VALUES (
    'render',
    p_user_id,
    p_episode_id,
    v_clip_id,
    jsonb_build_object(
      'clip_id', v_clip_id,
      'estimated_cost_usd', v_estimated_cost_usd
    ),
    'pending'
  )
  RETURNING id INTO v_job_id;

  RETURN QUERY
    SELECT v_clip_id, v_job_id, GREATEST(0, v_limit - v_used), NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.clips_submit_job(uuid, uuid, integer, integer, text, text, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clips_submit_job(uuid, uuid, integer, integer, text, text, text, jsonb, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_submit_job(uuid, uuid, integer, integer, text, text, text, jsonb, jsonb) TO service_role;

COMMENT ON TABLE public.clips_budget_guard IS
  'Opt-in application-scoped render COGS guard. It cannot stop other Railway projects.';
COMMENT ON FUNCTION public.clips_submit_job(uuid, uuid, integer, integer, text, text, text, jsonb, jsonb) IS
  'Atomically checks optional application budget and user quota, then creates a pending render reservation. Service role only.';
