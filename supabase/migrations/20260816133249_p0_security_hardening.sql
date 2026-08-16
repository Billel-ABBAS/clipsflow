-- ClipsFlow P0 security hardening.
-- This migration is intentionally repository-only until the target project
-- reference has been verified against NEXT_PUBLIC_SUPABASE_URL.

-- --------------------------------------------------------------------------
-- Browser mutation boundary
-- --------------------------------------------------------------------------

ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clips FORCE ROW LEVEL SECURITY;
ALTER TABLE public.jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "episodes_insert_own" ON public.episodes;
DROP POLICY IF EXISTS "episodes_update_own" ON public.episodes;
DROP POLICY IF EXISTS "clips_insert_own" ON public.clips;
DROP POLICY IF EXISTS "clips_update_own" ON public.clips;
DROP POLICY IF EXISTS "jobs_insert_own" ON public.jobs;

REVOKE INSERT, UPDATE ON TABLE public.episodes, public.clips FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.jobs FROM anon, authenticated;
REVOKE UPDATE ON TABLE public.profiles FROM anon, authenticated;

-- Authenticated users may update only presentation/identity fields. The
-- row policy still restricts the update to auth.uid() = profiles.id.
GRANT UPDATE (email, full_name, locale) ON TABLE public.profiles TO authenticated;

-- Defense in depth: column grants are the primary boundary, while this
-- trigger also rejects sensitive changes if a broad grant is reintroduced.
CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(auth.role()::text, '') <> 'service_role' THEN
    IF NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
       OR NEW.clip_seconds_used_this_month IS DISTINCT FROM OLD.clip_seconds_used_this_month
       OR NEW.clip_quota_reset_at IS DISTINCT FROM OLD.clip_quota_reset_at THEN
      RAISE EXCEPTION 'profile sensitive fields are server-managed'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_billing ON public.profiles;
DROP TRIGGER IF EXISTS trg_guard_profile_sensitive_fields ON public.profiles;
CREATE TRIGGER trg_guard_profile_sensitive_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_sensitive_fields();

DROP FUNCTION IF EXISTS public.guard_profile_billing();

REVOKE ALL ON FUNCTION public.guard_profile_sensitive_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_profile_sensitive_fields() FROM anon, authenticated;

-- --------------------------------------------------------------------------
-- Atomic service-side job submission
-- --------------------------------------------------------------------------

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
BEGIN
  v_duration := p_end_seconds - p_start_seconds;
  IF p_start_seconds < 0 OR v_duration <= 0 OR v_duration > 180 THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::uuid, 0, 'invalid_input'::text;
    RETURN;
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
    jsonb_build_object('clip_id', v_clip_id),
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

COMMENT ON FUNCTION public.clips_submit_job(uuid, uuid, integer, integer, text, text, text, jsonb, jsonb) IS
  'Atomically verifies ownership and quota, then creates a pending clip and render job. Service role only.';

-- --------------------------------------------------------------------------
-- Distributed fixed-window rate limiting
-- --------------------------------------------------------------------------

CREATE TABLE public.api_rate_limits (
  key text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 256),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_rate_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_rate_limits FROM PUBLIC, anon, authenticated;

CREATE INDEX idx_api_rate_limits_window_started
  ON public.api_rate_limits (window_started_at);

CREATE OR REPLACE FUNCTION public.consume_api_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (
  allowed boolean,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_window_started_at timestamptz;
  v_request_count integer;
  v_retry_after integer;
BEGIN
  IF p_key IS NULL
     OR char_length(p_key) NOT BETWEEN 1 AND 256
     OR p_limit NOT BETWEEN 1 AND 10000
     OR p_window_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'invalid rate limit arguments' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.api_rate_limits AS existing (
    key,
    window_started_at,
    request_count,
    updated_at
  ) VALUES (
    p_key,
    v_now,
    1,
    v_now
  )
  ON CONFLICT (key) DO UPDATE
  SET
    request_count = CASE
      WHEN existing.window_started_at + make_interval(secs => p_window_seconds) <= v_now
        THEN 1
      ELSE existing.request_count + 1
    END,
    window_started_at = CASE
      WHEN existing.window_started_at + make_interval(secs => p_window_seconds) <= v_now
        THEN v_now
      ELSE existing.window_started_at
    END,
    updated_at = v_now
  RETURNING request_count, window_started_at
    INTO v_request_count, v_window_started_at;

  IF v_request_count <= p_limit THEN
    RETURN QUERY SELECT true, 0;
    RETURN;
  END IF;

  v_retry_after := GREATEST(
    1,
    CEIL(
      EXTRACT(
        epoch FROM (
          v_window_started_at + make_interval(secs => p_window_seconds) - v_now
        )
      )
    )::integer
  );
  RETURN QUERY SELECT false, v_retry_after;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_api_rate_limit(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_api_rate_limit(text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_api_rate_limit(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.consume_api_rate_limit(text, integer, integer) IS
  'Atomically consumes one fixed-window request token. Service role only.';
