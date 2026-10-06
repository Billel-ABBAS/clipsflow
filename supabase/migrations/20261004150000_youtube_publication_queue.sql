-- ClipsFlow Shorts — resumable, explicitly confirmed YouTube publishing.
-- All publication records and OAuth credentials stay server-mediated.

ALTER TABLE public.youtube_connections
  ALTER COLUMN refresh_token_ciphertext DROP NOT NULL,
  ALTER COLUMN scopes SET DEFAULT ARRAY[
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly'
  ]::text[];

ALTER TABLE public.shorts_publications
  ADD COLUMN IF NOT EXISTS made_for_kids boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contains_synthetic_media boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_subscribers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS worker_lease_token uuid,
  ADD COLUMN IF NOT EXISTS worker_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS upload_session_uri_ciphertext text,
  ADD COLUMN IF NOT EXISTS upload_offset_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_code text;

ALTER TABLE public.shorts_publications
  ADD CONSTRAINT shorts_publications_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 5),
  ADD CONSTRAINT shorts_publications_upload_offset_check
    CHECK (upload_offset_bytes >= 0),
  ADD CONSTRAINT shorts_publications_worker_lease_check
    CHECK ((worker_lease_token IS NULL) = (worker_lease_expires_at IS NULL)),
  ADD CONSTRAINT shorts_publications_upload_session_check
    CHECK (upload_session_uri_ciphertext IS NULL OR char_length(upload_session_uri_ciphertext) >= 32);

CREATE INDEX shorts_publications_claim_idx
  ON public.shorts_publications(next_attempt_at, created_at)
  WHERE status IN ('queued', 'uploading') AND confirmed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.shorts_claim_youtube_publication(
  p_lease_seconds integer DEFAULT 300
)
RETURNS TABLE(publication_id uuid, lease_token uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 900 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT publication.id
    FROM public.shorts_publications AS publication
    WHERE publication.status IN ('queued', 'uploading')
      AND publication.confirmed_at IS NOT NULL
      AND publication.next_attempt_at <= v_now
      AND (
        publication.worker_lease_expires_at IS NULL
        OR publication.worker_lease_expires_at <= v_now
      )
      AND publication.attempt_count < 5
    ORDER BY publication.next_attempt_at ASC, publication.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.shorts_publications AS publication
  SET status = 'uploading',
      attempt_count = publication.attempt_count + 1,
      worker_lease_token = gen_random_uuid(),
      worker_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  FROM candidate
  WHERE publication.id = candidate.id
  RETURNING publication.id, publication.worker_lease_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.shorts_renew_youtube_publication_lease(
  p_publication_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_rows integer;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 900 THEN
    RETURN false;
  END IF;
  UPDATE public.shorts_publications AS publication
  SET worker_lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  WHERE publication.id = p_publication_id
    AND publication.status = 'uploading'
    AND publication.worker_lease_token = p_lease_token
    AND publication.worker_lease_expires_at > v_now;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.shorts_save_youtube_upload_progress(
  p_publication_id uuid,
  p_lease_token uuid,
  p_session_uri_ciphertext text,
  p_upload_offset_bytes bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_rows integer;
BEGIN
  IF p_session_uri_ciphertext IS NULL
    OR char_length(p_session_uri_ciphertext) < 32
    OR p_upload_offset_bytes IS NULL
    OR p_upload_offset_bytes < 0
  THEN
    RETURN false;
  END IF;
  UPDATE public.shorts_publications AS publication
  SET upload_session_uri_ciphertext = p_session_uri_ciphertext,
      upload_offset_bytes = p_upload_offset_bytes,
      updated_at = v_now
  WHERE publication.id = p_publication_id
    AND publication.status = 'uploading'
    AND publication.worker_lease_token = p_lease_token
    AND publication.worker_lease_expires_at > v_now;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.shorts_complete_youtube_publication(
  p_publication_id uuid,
  p_lease_token uuid,
  p_youtube_video_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_rows integer;
BEGIN
  IF p_youtube_video_id IS NULL
    OR p_youtube_video_id !~ '^[A-Za-z0-9_-]{6,128}$'
  THEN
    RETURN false;
  END IF;
  UPDATE public.shorts_publications AS publication
  SET status = 'published',
      youtube_video_id = p_youtube_video_id,
      youtube_url = 'https://www.youtube.com/shorts/' || p_youtube_video_id,
      published_at = v_now,
      confirmation_token_hash = NULL,
      confirmation_expires_at = NULL,
      upload_session_uri_ciphertext = NULL,
      upload_offset_bytes = 0,
      worker_lease_token = NULL,
      worker_lease_expires_at = NULL,
      error_code = NULL,
      error_message = NULL,
      updated_at = v_now
  WHERE publication.id = p_publication_id
    AND publication.status = 'uploading'
    AND publication.worker_lease_token = p_lease_token
    AND publication.worker_lease_expires_at > v_now;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.shorts_fail_youtube_publication(
  p_publication_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean DEFAULT false,
  p_retry_delay_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_rows integer;
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{1,80}$' THEN
    RETURN false;
  END IF;
  UPDATE public.shorts_publications AS publication
  SET status = CASE
        WHEN p_retryable AND publication.attempt_count < 5 THEN 'queued'
        ELSE 'failed'
      END,
      next_attempt_at = v_now + make_interval(
        secs => LEAST(GREATEST(COALESCE(p_retry_delay_seconds, 60), 30), 900)
      ),
      error_code = p_error_code,
      error_message = p_error_code,
      upload_session_uri_ciphertext = CASE
        WHEN p_retryable AND publication.attempt_count < 5
          THEN publication.upload_session_uri_ciphertext
        ELSE NULL
      END,
      upload_offset_bytes = CASE
        WHEN p_retryable AND publication.attempt_count < 5
          THEN publication.upload_offset_bytes
        ELSE 0
      END,
      worker_lease_token = NULL,
      worker_lease_expires_at = NULL,
      updated_at = v_now
  WHERE publication.id = p_publication_id
    AND publication.status = 'uploading'
    AND publication.worker_lease_token = p_lease_token
    AND publication.worker_lease_expires_at > v_now;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.shorts_claim_youtube_publication(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shorts_renew_youtube_publication_lease(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shorts_save_youtube_upload_progress(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shorts_complete_youtube_publication(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shorts_fail_youtube_publication(uuid, uuid, text, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_claim_youtube_publication(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.shorts_renew_youtube_publication_lease(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.shorts_save_youtube_upload_progress(uuid, uuid, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.shorts_complete_youtube_publication(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shorts_fail_youtube_publication(uuid, uuid, text, boolean, integer) TO service_role;
