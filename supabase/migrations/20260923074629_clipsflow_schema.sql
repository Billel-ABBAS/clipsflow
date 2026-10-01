-- ============================================================================
-- 0002_clips_schema.sql — Clips schema for PolyCast (Phase 1)
-- ============================================================================
-- Tables : episodes, clips, jobs
-- ALTER profiles : clip quota columns
-- RPCs : clips_reserve_quota, clips_refund_quota, reset_clip_quotas_due
-- Storage buckets : clip-sources, clip-outputs
-- Realtime : clips table
--
-- Application (when Supabase dev project exists) :
--   npx supabase db query --linked --file supabase/migrations/0002_clips_schema.sql
-- ============================================================================

-- ============================================================================
-- Table : episodes
-- ============================================================================
CREATE TABLE public.episodes (
  id                  uuid              NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             uuid              NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  title               text              NOT NULL,
  source_type         text              NOT NULL CHECK (source_type IN ('upload', 'url')),
  source_url          text              CHECK (source_url IS NULL OR source_url LIKE 'https://%'),
  source_storage_path text,
  duration_seconds    int,
  transcript_text     text,
  transcript_segments jsonb,
  transcript_language text,
  status              text              NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message       text,
  created_at          timestamptz       NOT NULL DEFAULT now()
);

ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "episodes_select_own"
  ON public.episodes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "episodes_insert_own"
  ON public.episodes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "episodes_update_own"
  ON public.episodes FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "episodes_delete_own"
  ON public.episodes FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_episodes_user_created
  ON public.episodes (user_id, created_at DESC);

-- ============================================================================
-- Table : clips
-- ============================================================================
CREATE TABLE public.clips (
  id                        uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  episode_id                uuid        NOT NULL REFERENCES public.episodes (id) ON DELETE CASCADE,
  user_id                   uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  start_seconds             int         NOT NULL CHECK (start_seconds >= 0),
  end_seconds               int         NOT NULL CHECK (end_seconds > start_seconds),
  duration_seconds          int         GENERATED ALWAYS AS (end_seconds - start_seconds) STORED,
  hook_text                 text,
  score                     smallint    CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  status                    text        NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'processing', 'completing', 'completed', 'failed')),
  style_key                 text        NOT NULL
                                        CHECK (style_key IN (
                                          'viral', 'premium', 'hormozi', 'mrbeast', 'iman',
                                          'minimal', 'neon', 'typewriter', 'bounce', 'bar',
                                          'cinematic', 'karaoke_pop', 'halo_glow',
                                          'trailer_inferno', 'comic_bubble'
                                        )),
  aspect_ratio              text        NOT NULL DEFAULT '9:16'
                                        CHECK (aspect_ratio IN ('9:16', '1:1', '4:5', '16:9')),
  language                  text        NOT NULL DEFAULT 'en',
  customizations            jsonb       NOT NULL DEFAULT '{}'::jsonb
                                        CHECK (jsonb_typeof(customizations) = 'object'),
  overlays                  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  video_url                 text,
  video_storage_path        text,
  thumbnail_url             text,
  thumbnail_storage_path    text,
  captions_vtt_url          text,
  captions_vtt_storage_path text,
  cost_usd                  numeric(10,4),
  error_message             text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  completed_at              timestamptz
);

ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clips_select_own"
  ON public.clips FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "clips_insert_own"
  ON public.clips FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "clips_update_own"
  ON public.clips FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "clips_delete_own"
  ON public.clips FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_clips_user_status_created
  ON public.clips (user_id, status, created_at DESC);

CREATE INDEX idx_clips_episode
  ON public.clips (episode_id);

CREATE INDEX idx_clips_video_storage_path
  ON public.clips (video_storage_path)
  WHERE video_storage_path IS NOT NULL;

-- ============================================================================
-- Realtime on clips
-- ============================================================================
-- Add to the realtime publication. ALTER PUBLICATION errors with
-- "already member" if the table is already in the publication — wrap
-- in a DO block + SQLSTATE check so the migration is replayable.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.clips;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END
$$;

-- REPLICA IDENTITY FULL so UPDATE payloads carry the full new row image
-- that Realtime needs for postgres_changes events.
ALTER TABLE public.clips REPLICA IDENTITY FULL;

-- ============================================================================
-- Table : jobs
-- ============================================================================
CREATE TABLE public.jobs (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type            text        NOT NULL CHECK (type IN ('transcribe', 'clip_extract', 'render')),
  user_id         uuid        NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  episode_id      uuid        REFERENCES public.episodes (id) ON DELETE CASCADE,
  clip_id         uuid        REFERENCES public.clips (id) ON DELETE CASCADE,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count   int         NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

-- Users can select and insert their own jobs.
-- Update / delete are reserved for service_role (pipeline worker) which bypasses RLS.
CREATE POLICY "jobs_select_own"
  ON public.jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "jobs_insert_own"
  ON public.jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_jobs_status_created
  ON public.jobs (status, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX idx_jobs_status_attempts
  ON public.jobs (status, attempt_count)
  WHERE status = 'pending';

CREATE INDEX idx_jobs_user_created
  ON public.jobs (user_id, created_at DESC);

-- ============================================================================
-- ALTER profiles — clip quota columns
-- ============================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS clip_seconds_used_this_month int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clip_quota_reset_at timestamptz DEFAULT (date_trunc('month', now()) + interval '1 month');

-- ============================================================================
-- RPCs — atomic clip quota management (SECURITY DEFINER)
-- ============================================================================
-- Pattern mirrors `clipflow_reserve_quota` from VidiaFlow migration
-- 20260512010_quota_atomic_rpcs.sql : UPDATE...WHERE...RETURNING with
-- per-row serialisation prevents the "read quota → check → increment"
-- race condition under concurrent submissions.
--
-- All three RPCs :
--   - REVOKE from anon + authenticated
--   - GRANT EXECUTE to service_role only
--   - set search_path = public
-- ============================================================================

-- clips_reserve_quota : atomic check-and-increment
-- Returns true if reservation succeeded (used + p_seconds <= p_limit).
-- Returns false if quota would be exceeded (or user not found).
CREATE OR REPLACE FUNCTION clips_reserve_quota(
  p_user_id uuid,
  p_seconds  int,
  p_limit    int
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used int;
BEGIN
  -- Atomic check-and-reserve. Two concurrent p_seconds=100 calls with
  -- limit=180 and used=0 : first lands used=100, second's WHERE
  -- (0+100 + 100 <= 180 ?) no — sees 100, evaluates 100+100=200>180,
  -- WHERE fails, RETURNING null → second returns false.
  UPDATE profiles
  SET clip_seconds_used_this_month = clip_seconds_used_this_month + p_seconds
  WHERE id = p_user_id
    AND clip_seconds_used_this_month + p_seconds <= p_limit
  RETURNING clip_seconds_used_this_month INTO v_used;

  RETURN v_used IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION clips_reserve_quota(uuid, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION clips_reserve_quota(uuid, int, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION clips_reserve_quota(uuid, int, int) TO service_role;

COMMENT ON FUNCTION clips_reserve_quota(uuid, int, int) IS
  'Atomic reservation of profiles.clip_seconds_used_this_month. Returns true when reservation succeeded, false when quota exceeded. Closes race condition on concurrent clip submissions.';


-- clips_refund_quota : decrement with floor at 0
CREATE OR REPLACE FUNCTION clips_refund_quota(
  p_user_id uuid,
  p_seconds  int
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE profiles
  SET clip_seconds_used_this_month =
        GREATEST(0, clip_seconds_used_this_month - p_seconds)
  WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION clips_refund_quota(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION clips_refund_quota(uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION clips_refund_quota(uuid, int) TO service_role;

COMMENT ON FUNCTION clips_refund_quota(uuid, int) IS
  'Refund p_seconds from profiles.clip_seconds_used_this_month, clamped to 0. Called when a clip job fails after quota was already reserved.';


-- reset_clip_quotas_due : monthly quota reset
-- Resets clip_seconds_used_this_month to 0 and advances clip_quota_reset_at
-- by one month for every profile whose reset date has arrived.
-- Returns the number of rows reset.
CREATE OR REPLACE FUNCTION reset_clip_quotas_due()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  WITH updated AS (
    UPDATE profiles
    SET
      clip_seconds_used_this_month = 0,
      clip_quota_reset_at = clip_quota_reset_at + interval '1 month'
    WHERE clip_quota_reset_at <= now()
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION reset_clip_quotas_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_clip_quotas_due() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION reset_clip_quotas_due() TO service_role;

COMMENT ON FUNCTION reset_clip_quotas_due() IS
  'Monthly cron reset. For each profile whose clip_quota_reset_at <= now(), resets clip_seconds_used_this_month to 0 and advances reset date by 1 month. Returns count of rows reset.';

-- ============================================================================
-- Storage bucket : clip-sources (private, user-uploaded source media)
-- ============================================================================
-- Input bucket for user-uploaded audio/video source files consumed by the
-- transcription + clip extraction pipeline.
-- Supported MIME types extend the original video-only list to include
-- audio formats (MP3, M4A, WAV) so podcast creators can upload audio files.
-- Path layout : {user_id}/{uuid}-{filename}
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'clip-sources',
  'clip-sources',
  false,
  524288000,  -- 500 MB
  ARRAY[
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/wav'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Users read their own uploads (e.g. to generate a signed URL for pipeline).
CREATE POLICY "clip_sources_read_own"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'clip-sources'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Users upload under their own folder.
CREATE POLICY "clip_sources_insert_own"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'clip-sources'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Users can delete their own uploads to free storage quota.
CREATE POLICY "clip_sources_delete_own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'clip-sources'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================================
-- Storage bucket : clip-outputs (private, pipeline-written rendered clips)
-- ============================================================================
-- Output bucket where the render pipeline writes MP4 clips, WebVTT sidecar
-- captions, and JPEG thumbnails. Path layout : {user_id}/{clip_id}/{file}.
-- Insert and update are reserved for service_role — the pipeline runs under
-- service_role which bypasses RLS. Authenticated users can only read and
-- delete their own outputs.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'clip-outputs',
  'clip-outputs',
  false,
  524288000,  -- 500 MB
  ARRAY['video/mp4', 'text/vtt', 'image/jpeg']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Users read their own rendered outputs.
CREATE POLICY "clip_outputs_read_own"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'clip-outputs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Users can delete their own rendered clips.
CREATE POLICY "clip_outputs_delete_own"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'clip-outputs'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Insert reserved for service_role (pipeline writer).
CREATE POLICY "clip_outputs_service_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'clip-outputs'
    AND auth.role() = 'service_role'
  );

-- Update reserved for service_role (pipeline writer).
CREATE POLICY "clip_outputs_service_update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'clip-outputs'
    AND auth.role() = 'service_role'
  )
  WITH CHECK (
    bucket_id = 'clip-outputs'
    AND auth.role() = 'service_role'
  );
