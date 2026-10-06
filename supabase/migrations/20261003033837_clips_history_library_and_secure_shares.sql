-- ClipsFlow history, private library metadata, share links, and retry safety.
-- User mutations are routed through authenticated server handlers; the new
-- tables are deliberately unavailable through the public Data API.

ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS submission_request_id uuid,
  ADD COLUMN IF NOT EXISTS source_request_fingerprint text
    CHECK (source_request_fingerprint IS NULL OR source_request_fingerprint ~ '^[0-9a-f]{64}$');

-- NULL is distinct in a PostgreSQL unique index, so existing/manual episodes
-- remain unrestricted while a retried URL submission resolves to one row.
CREATE UNIQUE INDEX IF NOT EXISTS episodes_user_submission_request_idx
  ON public.episodes(user_id, submission_request_id);

ALTER TABLE public.clips
  ADD COLUMN IF NOT EXISTS title_override text
    CHECK (title_override IS NULL OR char_length(title_override) <= 120),
  ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transcript_segments jsonb
    CHECK (transcript_segments IS NULL OR jsonb_typeof(transcript_segments) = 'array'),
  ADD COLUMN IF NOT EXISTS transcript_language text;

ALTER TABLE public.clips
  ADD CONSTRAINT clips_id_user_unique UNIQUE (id, user_id);

CREATE TABLE public.clip_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clip_collections_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT clip_collections_user_name_unique UNIQUE (user_id, name)
);

CREATE TABLE public.clip_collection_items (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL,
  clip_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, clip_id),
  CONSTRAINT clip_collection_items_collection_owner_fk
    FOREIGN KEY (collection_id, user_id)
    REFERENCES public.clip_collections(id, user_id) ON DELETE CASCADE,
  CONSTRAINT clip_collection_items_clip_owner_fk
    FOREIGN KEY (clip_id, user_id)
    REFERENCES public.clips(id, user_id) ON DELETE CASCADE
);

CREATE INDEX clip_collection_items_user_clip_idx
  ON public.clip_collection_items(user_id, clip_id);

CREATE TABLE public.clip_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  clip_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT clip_share_links_clip_owner_fk
    FOREIGN KEY (clip_id, user_id)
    REFERENCES public.clips(id, user_id) ON DELETE CASCADE
);

CREATE INDEX clip_share_links_active_clip_idx
  ON public.clip_share_links(clip_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.clip_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clip_collections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clip_collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clip_collection_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clip_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clip_share_links FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.clip_collections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.clip_collection_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.clip_share_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clip_collections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clip_collection_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clip_share_links TO service_role;

-- The idempotent wrapper locks one user/request pair, checks for an earlier
-- accepted submission, and calls the existing budget/quota RPC in the same
-- transaction. A lost HTTP response can therefore be retried without a
-- second reservation or render.
CREATE OR REPLACE FUNCTION public.clips_submit_job_idempotent(
  p_user_id uuid,
  p_episode_id uuid,
  p_start_seconds integer,
  p_end_seconds integer,
  p_style_key text,
  p_aspect_ratio text,
  p_language text,
  p_customizations jsonb,
  p_overlays jsonb,
  p_request_id uuid
) RETURNS TABLE (
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
  v_limit integer;
  v_used integer;
  v_clip_id uuid;
  v_job_id uuid;
  v_remaining integer;
  v_error_code text;
  v_request_fingerprint jsonb;
  v_existing_fingerprint jsonb;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 'invalid_request_id'::text;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_request_id::text, 0)
  );

  v_request_fingerprint := pg_catalog.jsonb_build_object(
    'episode_id', p_episode_id,
    'start_seconds', p_start_seconds,
    'end_seconds', p_end_seconds,
    'style_key', p_style_key,
    'aspect_ratio', p_aspect_ratio,
    'language', p_language,
    'customizations', COALESCE(p_customizations, '{}'::jsonb),
    'overlays', COALESCE(p_overlays, '[]'::jsonb)
  );

  SELECT clip.id, job.id, job.payload -> 'request_fingerprint'
    INTO v_clip_id, v_job_id, v_existing_fingerprint
  FROM public.jobs AS job
  JOIN public.clips AS clip ON clip.id = job.clip_id
  WHERE job.user_id = p_user_id
    AND job.payload ->> 'request_id' = p_request_id::text
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    IF v_existing_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 'idempotency_conflict'::text;
      RETURN;
    END IF;

    SELECT
      CASE profile.plan
        WHEN 'free' THEN 60
        WHEN 'solo' THEN 480
        WHEN 'pro' THEN 1800
        WHEN 'studio' THEN 3600
        ELSE 0
      END,
      profile.clip_seconds_used_this_month
      INTO v_limit, v_used
    FROM public.profiles AS profile
    WHERE profile.id = p_user_id;

    RETURN QUERY SELECT
      v_clip_id,
      v_job_id,
      GREATEST(0, COALESCE(v_limit, 0) - COALESCE(v_used, 0)),
      NULL::text;
    RETURN;
  END IF;

  SELECT submitted.clip_id, submitted.job_id,
         submitted.remaining_seconds, submitted.error_code
    INTO v_clip_id, v_job_id, v_remaining, v_error_code
  FROM public.clips_submit_job(
    p_user_id,
    p_episode_id,
    p_start_seconds,
    p_end_seconds,
    p_style_key,
    p_aspect_ratio,
    p_language,
    p_customizations,
    p_overlays
  ) AS submitted
  LIMIT 1;

  IF v_error_code IS NULL AND v_job_id IS NOT NULL THEN
    UPDATE public.jobs
    SET payload = payload || pg_catalog.jsonb_build_object(
      'request_id', p_request_id,
      'request_fingerprint', v_request_fingerprint
    )
    WHERE id = v_job_id AND user_id = p_user_id;
  END IF;

  RETURN QUERY SELECT v_clip_id, v_job_id, COALESCE(v_remaining, 0), v_error_code;
END;
$$;

REVOKE ALL ON FUNCTION public.clips_submit_job_idempotent(uuid, uuid, integer, integer, text, text, text, jsonb, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_submit_job_idempotent(uuid, uuid, integer, integer, text, text, text, jsonb, jsonb, uuid) TO service_role;

-- Retrying a failed render is idempotent while a retry is queued/running,
-- returns an already completed retry, and reserves quota through the same
-- budget-aware submit RPC for each intentional new attempt.
CREATE OR REPLACE FUNCTION public.clips_retry_failed_job(
  p_user_id uuid,
  p_source_clip_id uuid,
  p_request_id uuid
) RETURNS TABLE (
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
  v_episode_id uuid;
  v_start_seconds integer;
  v_end_seconds integer;
  v_style_key text;
  v_aspect_ratio text;
  v_language text;
  v_customizations jsonb;
  v_overlays jsonb;
  v_clip_id uuid;
  v_job_id uuid;
  v_remaining integer;
  v_error_code text;
  v_existing_status text;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 'invalid_request_id'::text;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('retry:' || p_user_id::text || ':' || p_source_clip_id::text, 0)
  );

  -- Return the exact result for a retried HTTP request, including a fast
  -- failure. A user-initiated later attempt receives a fresh request UUID.
  SELECT retry_clip.id, retry_job.id, retry_clip.status
    INTO v_clip_id, v_job_id, v_existing_status
  FROM public.jobs AS retry_job
  JOIN public.clips AS retry_clip ON retry_clip.id = retry_job.clip_id
  WHERE retry_job.user_id = p_user_id
    AND retry_job.payload ->> 'retry_of_clip_id' = p_source_clip_id::text
    AND COALESCE(retry_job.payload -> 'retry_request_ids', '[]'::jsonb)
      @> pg_catalog.jsonb_build_array(p_request_id::text)
  ORDER BY retry_job.created_at DESC
  LIMIT 1;

  IF v_job_id IS NULL THEN
    SELECT retry_clip.id, retry_job.id, retry_clip.status
      INTO v_clip_id, v_job_id, v_existing_status
    FROM public.jobs AS retry_job
    JOIN public.clips AS retry_clip ON retry_clip.id = retry_job.clip_id
    WHERE retry_job.user_id = p_user_id
      AND retry_job.payload ->> 'retry_of_clip_id' = p_source_clip_id::text
    ORDER BY retry_job.created_at DESC
    LIMIT 1;
  END IF;

  IF v_job_id IS NOT NULL AND (
    v_existing_status IN ('pending', 'processing', 'completing', 'completed')
    OR EXISTS (
      SELECT 1
      FROM public.jobs AS retry_job
      WHERE retry_job.id = v_job_id
        AND COALESCE(retry_job.payload -> 'retry_request_ids', '[]'::jsonb)
          @> pg_catalog.jsonb_build_array(p_request_id::text)
    )
  ) THEN
    -- Bind a new click that reused an active attempt to that same attempt as
    -- well, so a replay of the HTTP request cannot create a later attempt.
    UPDATE public.jobs
    SET payload = pg_catalog.jsonb_set(
      payload,
      '{retry_request_ids}',
      COALESCE(payload -> 'retry_request_ids', '[]'::jsonb)
        || pg_catalog.jsonb_build_array(p_request_id::text),
      true
    )
    WHERE id = v_job_id
      AND user_id = p_user_id
      AND NOT (
        COALESCE(payload -> 'retry_request_ids', '[]'::jsonb)
        @> pg_catalog.jsonb_build_array(p_request_id::text)
      );

    SELECT GREATEST(0,
      CASE profile.plan
        WHEN 'free' THEN 60
        WHEN 'solo' THEN 480
        WHEN 'pro' THEN 1800
        WHEN 'studio' THEN 3600
        ELSE 0
      END - profile.clip_seconds_used_this_month
    ) INTO v_remaining
    FROM public.profiles AS profile
    WHERE profile.id = p_user_id;

    RETURN QUERY SELECT v_clip_id, v_job_id, COALESCE(v_remaining, 0), NULL::text;
    RETURN;
  END IF;

  SELECT episode_id, start_seconds, end_seconds, style_key, aspect_ratio,
         language, customizations, overlays
    INTO v_episode_id, v_start_seconds, v_end_seconds, v_style_key,
         v_aspect_ratio, v_language, v_customizations, v_overlays
  FROM public.clips
  WHERE id = p_source_clip_id
    AND user_id = p_user_id
    AND status = 'failed';

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 'not_retryable'::text;
    RETURN;
  END IF;

  SELECT submitted.clip_id, submitted.job_id,
         submitted.remaining_seconds, submitted.error_code
    INTO v_clip_id, v_job_id, v_remaining, v_error_code
  FROM public.clips_submit_job(
    p_user_id,
    v_episode_id,
    v_start_seconds,
    v_end_seconds,
    v_style_key,
    v_aspect_ratio,
    v_language,
    v_customizations,
    v_overlays
  ) AS submitted
  LIMIT 1;

  IF v_error_code IS NULL AND v_job_id IS NOT NULL THEN
    UPDATE public.jobs
    SET payload = payload || pg_catalog.jsonb_build_object(
      'retry_of_clip_id', p_source_clip_id,
      'retry_request_ids', pg_catalog.jsonb_build_array(p_request_id::text)
    )
    WHERE id = v_job_id AND user_id = p_user_id;
  END IF;

  RETURN QUERY SELECT v_clip_id, v_job_id, COALESCE(v_remaining, 0), v_error_code;
END;
$$;

REVOKE ALL ON FUNCTION public.clips_retry_failed_job(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_retry_failed_job(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.clips_set_collection(
  p_user_id uuid,
  p_clip_id uuid,
  p_collection_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'collection:' || p_user_id::text || ':' || p_clip_id::text,
      0
    )
  );

  PERFORM 1 FROM public.clips
  WHERE id = p_clip_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN 'clip_not_found';
  END IF;

  IF p_collection_id IS NOT NULL THEN
    PERFORM 1 FROM public.clip_collections
    WHERE id = p_collection_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RETURN 'collection_not_found';
    END IF;
  END IF;

  DELETE FROM public.clip_collection_items
  WHERE clip_id = p_clip_id AND user_id = p_user_id;

  IF p_collection_id IS NOT NULL THEN
    INSERT INTO public.clip_collection_items (user_id, collection_id, clip_id)
    VALUES (p_user_id, p_collection_id, p_clip_id);
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.clips_set_collection(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_set_collection(uuid, uuid, uuid) TO service_role;

COMMENT ON TABLE public.clip_share_links IS
  'Revocable private-share records; only SHA-256 token hashes are stored. Public pages issue short-lived signed Storage URLs after token verification.';
