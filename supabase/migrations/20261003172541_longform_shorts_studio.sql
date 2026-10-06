-- Long-form Shorts Studio: durable analysis, candidate selection, and
-- YouTube publication intent.  Every table stays server-mediated: browser
-- clients never receive access to analysis payloads or OAuth refresh tokens.
--
-- Migration 20261004104751_shorts_large_source_uploads raises the private
-- source bucket limit and enables the application-side TUS upload contract.
-- Production operators must also set the project-wide Storage limit in
-- Storage Settings to at least 8 GiB before accepting large source files.

CREATE TABLE public.shorts_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  analysis_mode text NOT NULL
    CHECK (analysis_mode IN ('audio', 'audio_video')),
  user_instructions text NOT NULL DEFAULT ''
    CHECK (char_length(user_instructions) <= 1200),
  jev_shadow_consent boolean NOT NULL DEFAULT false,
  source_duration_seconds integer,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'queued', 'transcribing', 'analyzing', 'ready', 'failed')),
  transcription_model text,
  analysis_model text,
  vision_model text,
  transcript_language text,
  transcript_text text
    CHECK (transcript_text IS NULL OR char_length(transcript_text) <= 2000000),
  transcript_segments jsonb
    CHECK (
      transcript_segments IS NULL
      OR (
        jsonb_typeof(transcript_segments) = 'array'
        AND jsonb_array_length(transcript_segments) <= 120000
      )
    ),
  error_message text,
  analysis_payload jsonb,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT shorts_projects_duration_range
    CHECK (
      source_duration_seconds IS NULL
      OR source_duration_seconds BETWEEN 1200 AND 7200
    ),
  CONSTRAINT shorts_projects_payload_is_object
    CHECK (
      analysis_payload IS NULL
      OR jsonb_typeof(analysis_payload) = 'object'
    ),
  CONSTRAINT shorts_projects_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT shorts_projects_idempotency_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX shorts_projects_user_created_idx
  ON public.shorts_projects(user_id, created_at DESC);
CREATE INDEX shorts_projects_episode_created_idx
  ON public.shorts_projects(episode_id, created_at DESC);
CREATE INDEX shorts_projects_active_idx
  ON public.shorts_projects(user_id, created_at DESC)
  WHERE status IN ('queued', 'transcribing', 'analyzing');

CREATE TABLE public.shorts_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 100),
  start_seconds integer NOT NULL CHECK (start_seconds >= 0),
  end_seconds integer NOT NULL CHECK (end_seconds > start_seconds),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  hook text NOT NULL CHECK (char_length(hook) <= 280),
  title text NOT NULL CHECK (char_length(title) <= 160),
  rationale text NOT NULL CHECK (char_length(rationale) <= 1200),
  transcript_excerpt text NOT NULL CHECK (char_length(transcript_excerpt) <= 6000),
  music_mood text NOT NULL CHECK (music_mood IN (
    'focused', 'playful', 'uplifting', 'warm', 'energetic', 'minimal'
  )),
  motion_direction text NOT NULL CHECK (char_length(motion_direction) BETWEEN 1 AND 160),
  visual_summary text CHECK (char_length(visual_summary) <= 1200),
  production_profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(production_profile) = 'object'),
  selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shorts_candidates_duration_range
    CHECK (end_seconds - start_seconds BETWEEN 10 AND 180),
  CONSTRAINT shorts_candidates_project_owner_fk
    FOREIGN KEY (project_id, user_id)
    REFERENCES public.shorts_projects(id, user_id) ON DELETE CASCADE,
  CONSTRAINT shorts_candidates_unique_rank UNIQUE (project_id, rank),
  CONSTRAINT shorts_candidates_id_user_unique UNIQUE (id, user_id)
);

CREATE INDEX shorts_candidates_project_rank_idx
  ON public.shorts_candidates(project_id, rank);
CREATE INDEX shorts_candidates_user_selected_idx
  ON public.shorts_candidates(user_id, selected, created_at DESC);

CREATE TABLE public.shorts_audio_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  candidate_id uuid,
  provider text NOT NULL CHECK (provider IN ('elevenlabs', 'licensed_catalog')),
  kind text NOT NULL CHECK (kind IN ('music', 'sound_effect')),
  model_id text,
  prompt_hash text CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL CHECK (char_length(storage_path) BETWEEN 1 AND 600),
  duration_seconds numeric(8, 3) NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 300),
  license_reference text,
  generation_cost_credits integer CHECK (generation_cost_credits IS NULL OR generation_cost_credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shorts_audio_assets_project_owner_fk
    FOREIGN KEY (project_id, user_id)
    REFERENCES public.shorts_projects(id, user_id) ON DELETE CASCADE,
  CONSTRAINT shorts_audio_assets_candidate_owner_fk
    FOREIGN KEY (candidate_id, user_id)
    REFERENCES public.shorts_candidates(id, user_id) ON DELETE CASCADE
);

CREATE INDEX shorts_audio_assets_candidate_idx
  ON public.shorts_audio_assets(candidate_id, created_at DESC);
CREATE INDEX shorts_audio_assets_project_idx
  ON public.shorts_audio_assets(project_id, created_at DESC);

CREATE TABLE public.youtube_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'youtube' CHECK (provider = 'youtube'),
  channel_id text NOT NULL CHECK (char_length(channel_id) BETWEEN 1 AND 160),
  channel_title text NOT NULL CHECK (char_length(channel_title) BETWEEN 1 AND 200),
  refresh_token_ciphertext text NOT NULL CHECK (char_length(refresh_token_ciphertext) >= 32),
  encryption_key_version text NOT NULL DEFAULT 'v1'
    CHECK (char_length(encryption_key_version) BETWEEN 1 AND 32),
  scopes text[] NOT NULL DEFAULT ARRAY[
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly'
  ]::text[],
  is_active boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT youtube_connections_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT youtube_connections_user_channel_unique UNIQUE (user_id, provider, channel_id)
);

CREATE INDEX youtube_connections_active_user_idx
  ON public.youtube_connections(user_id, connected_at DESC)
  WHERE is_active AND disconnected_at IS NULL;

CREATE TABLE public.shorts_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  clip_id uuid NOT NULL,
  youtube_connection_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  tags text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(tags) <= 15),
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'awaiting_confirmation', 'queued', 'uploading', 'published', 'failed')),
  confirmation_token_hash text CHECK (confirmation_token_hash ~ '^[0-9a-f]{64}$'),
  confirmation_expires_at timestamptz,
  confirmed_at timestamptz,
  youtube_video_id text,
  youtube_url text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT shorts_publications_clip_owner_fk
    FOREIGN KEY (clip_id, user_id)
    REFERENCES public.clips(id, user_id) ON DELETE CASCADE,
  CONSTRAINT shorts_publications_connection_owner_fk
    FOREIGN KEY (youtube_connection_id, user_id)
    REFERENCES public.youtube_connections(id, user_id) ON DELETE CASCADE
);

CREATE INDEX shorts_publications_user_created_idx
  ON public.shorts_publications(user_id, created_at DESC);
CREATE INDEX shorts_publications_connection_status_idx
  ON public.shorts_publications(youtube_connection_id, status, created_at DESC);

-- These records include private transcripts, production intent, and encrypted
-- tokens.  The only supported access path is an authenticated server handler
-- using the service role after it has checked the caller's user id.
ALTER TABLE public.shorts_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_audio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_audio_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.youtube_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youtube_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_publications FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shorts_projects FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.shorts_candidates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.shorts_audio_assets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.youtube_connections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.shorts_publications FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shorts_projects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shorts_candidates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shorts_audio_assets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.youtube_connections TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shorts_publications TO service_role;

COMMENT ON TABLE public.shorts_projects IS
  'Server-mediated long-form analysis projects. A project corresponds to one owned episode plus analysis mode and creator instructions.';
COMMENT ON TABLE public.shorts_candidates IS
  'AI-proposed, user-selectable short windows. Candidate ownership is constrained to its analysis project owner.';
COMMENT ON TABLE public.shorts_audio_assets IS
  'Server-created ElevenLabs or licensed-catalog assets. Prompts are hashed and audio remains private in Storage.';
COMMENT ON TABLE public.youtube_connections IS
  'Server-only YouTube OAuth refresh tokens encrypted before persistence; never expose this table through the Data API.';
COMMENT ON TABLE public.shorts_publications IS
  'User-approved YouTube publication intents and outcomes; visibility defaults to private and confirmation is recorded separately.';

-- Dedicated queue for expensive long-form analysis.  It deliberately does
-- not reuse public.jobs: the render queue's lifecycle and quota-refund logic
-- are specific to finished 10-180 second clips, whereas an analysis job may
-- transcribe a 20 minute to two hour source before producing candidates.
CREATE TABLE public.shorts_analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  claimed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT shorts_analysis_jobs_project_owner_fk
    FOREIGN KEY (project_id, user_id)
    REFERENCES public.shorts_projects(id, user_id) ON DELETE CASCADE,
  CONSTRAINT shorts_analysis_jobs_one_per_project UNIQUE (project_id),
  CONSTRAINT shorts_analysis_jobs_id_user_unique UNIQUE (id, user_id)
);

CREATE INDEX shorts_analysis_jobs_ready_idx
  ON public.shorts_analysis_jobs(status, created_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX shorts_analysis_jobs_lease_idx
  ON public.shorts_analysis_jobs(status, lease_expires_at)
  WHERE status = 'processing';

ALTER TABLE public.shorts_analysis_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shorts_analysis_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shorts_analysis_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shorts_analysis_jobs TO service_role;

-- One server-side transaction creates the durable project and queues the
-- analysis.  The request id makes network retries safe without replaying a
-- costly transcription.  Browser clients never get table privileges.
CREATE OR REPLACE FUNCTION public.shorts_submit_analysis_job(
  p_user_id uuid,
  p_episode_id uuid,
  p_analysis_mode text,
  p_duration_seconds integer,
  p_user_instructions text,
  p_jev_shadow_consent boolean,
  p_idempotency_key uuid
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
BEGIN
  IF p_user_id IS NULL OR p_episode_id IS NULL OR p_idempotency_key IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'invalid_request'::text;
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
      OR v_project.source_duration_seconds IS DISTINCT FROM p_duration_seconds
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

  PERFORM 1
  FROM public.episodes AS episode
  WHERE episode.id = p_episode_id
    AND episode.user_id = p_user_id
    AND episode.status = 'ready';
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'episode_not_ready'::text;
    RETURN;
  END IF;

  INSERT INTO public.shorts_projects (
    user_id,
    episode_id,
    analysis_mode,
    user_instructions,
    jev_shadow_consent,
    source_duration_seconds,
    status,
    idempotency_key
  ) VALUES (
    p_user_id,
    p_episode_id,
    p_analysis_mode,
    COALESCE(p_user_instructions, ''),
    COALESCE(p_jev_shadow_consent, false),
    p_duration_seconds,
    'queued',
    p_idempotency_key
  )
  RETURNING * INTO v_project;

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

-- Claim one job at a time with a renewable lease.  An interrupted analysis
-- retries once; a second expired lease reaches a visible terminal failure.
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
DECLARE
  v_now timestamptz := now();
  v_stale public.shorts_analysis_jobs%ROWTYPE;
  v_claim public.shorts_analysis_jobs%ROWTYPE;
BEGIN
  IF p_lease_seconds < 300 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds_out_of_range' USING ERRCODE = '22023';
  END IF;

  FOR v_stale IN
    SELECT job.*
    FROM public.shorts_analysis_jobs AS job
    WHERE job.status = 'processing'
      AND job.lease_expires_at IS NOT NULL
      AND job.lease_expires_at <= v_now
    ORDER BY job.lease_expires_at ASC
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

  SELECT job.* INTO v_claim
  FROM public.shorts_analysis_jobs AS job
  WHERE job.status = 'pending'
  ORDER BY job.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
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
    RETURN;
  END IF;

  UPDATE public.shorts_analysis_jobs AS job
  SET
    status = 'processing',
    attempt_count = job.attempt_count + 1,
    claimed_at = v_now,
    lease_token = gen_random_uuid(),
    lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
    error_message = NULL
  WHERE job.id = v_claim.id
  RETURNING * INTO v_claim;

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

CREATE OR REPLACE FUNCTION public.shorts_renew_analysis_lease(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 1800
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_lease_seconds < 300 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease_seconds_out_of_range' USING ERRCODE = '22023';
  END IF;
  UPDATE public.shorts_analysis_jobs AS job
  SET lease_expires_at = v_now + make_interval(secs => p_lease_seconds)
  WHERE job.id = p_job_id
    AND job.status = 'processing'
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > v_now;
  RETURN FOUND;
END;
$$;

-- Progress updates are fenced just like final completion: a worker whose
-- lease expired cannot move a retry's project into the analysis state.
CREATE OR REPLACE FUNCTION public.shorts_mark_analysis_analyzing(
  p_job_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.shorts_analysis_jobs%ROWTYPE;
  v_now timestamptz := now();
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

  UPDATE public.shorts_projects AS project
  SET status = 'analyzing', updated_at = v_now
  WHERE project.id = v_job.project_id
    AND project.user_id = v_job.user_id
    AND project.status = 'transcribing';
  RETURN FOUND;
END;
$$;

-- The final state and candidate set are committed together.  A stale worker
-- cannot write candidates because the current non-expired lease is locked
-- before the transaction deletes/inserts anything.
CREATE OR REPLACE FUNCTION public.shorts_complete_analysis_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_transcript_language text,
  p_transcription_model text,
  p_analysis_model text,
  p_vision_model text,
  p_analysis_payload jsonb,
  p_source_duration_seconds integer,
  p_transcript_text text,
  p_transcript_segments jsonb,
  p_candidates jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.shorts_analysis_jobs%ROWTYPE;
  v_now timestamptz := now();
  v_candidate_count integer;
BEGIN
  IF jsonb_typeof(p_analysis_payload) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_transcript_segments) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_candidates) IS DISTINCT FROM 'array'
    OR p_source_duration_seconds NOT BETWEEN 1200 AND 7200
    OR char_length(COALESCE(p_transcript_text, '')) < 1
    OR char_length(COALESCE(p_transcript_text, '')) > 2000000
    OR (
      CASE
        WHEN jsonb_typeof(p_transcript_segments) = 'array'
          THEN jsonb_array_length(p_transcript_segments) > 120000
        ELSE true
      END
    ) THEN
    RAISE EXCEPTION 'invalid_analysis_payload' USING ERRCODE = '22023';
  END IF;
  v_candidate_count := jsonb_array_length(p_candidates);
  IF v_candidate_count < 1 OR v_candidate_count > 12 THEN
    RAISE EXCEPTION 'invalid_candidate_count' USING ERRCODE = '22023';
  END IF;

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

  DELETE FROM public.shorts_candidates AS candidate
  WHERE candidate.project_id = v_job.project_id
    AND candidate.user_id = v_job.user_id;

  INSERT INTO public.shorts_candidates (
    project_id,
    user_id,
    episode_id,
    rank,
    start_seconds,
    end_seconds,
    score,
    hook,
    title,
    rationale,
    transcript_excerpt,
    music_mood,
    motion_direction,
    visual_summary,
    production_profile
  )
  SELECT
    v_job.project_id,
    v_job.user_id,
    v_job.episode_id,
    (entry.value ->> 'rank')::integer,
    (entry.value ->> 'start_seconds')::integer,
    (entry.value ->> 'end_seconds')::integer,
    (entry.value ->> 'score')::smallint,
    entry.value ->> 'hook',
    entry.value ->> 'title',
    entry.value ->> 'rationale',
    entry.value ->> 'transcript_excerpt',
    entry.value ->> 'music_mood',
    entry.value ->> 'motion_direction',
    NULLIF(entry.value ->> 'visual_summary', ''),
    COALESCE(entry.value -> 'production_profile', '{}'::jsonb)
  FROM jsonb_array_elements(p_candidates) AS entry(value);

  UPDATE public.shorts_projects AS project
  SET
    status = 'ready',
    source_duration_seconds = p_source_duration_seconds,
    transcript_language = NULLIF(left(COALESCE(p_transcript_language, ''), 32), ''),
    transcription_model = NULLIF(left(COALESCE(p_transcription_model, ''), 120), ''),
    analysis_model = NULLIF(left(COALESCE(p_analysis_model, ''), 120), ''),
    vision_model = NULLIF(left(COALESCE(p_vision_model, ''), 120), ''),
    analysis_payload = p_analysis_payload,
    error_message = NULL,
    completed_at = v_now,
    updated_at = v_now
  WHERE project.id = v_job.project_id
    AND project.user_id = v_job.user_id
    AND project.status IN ('transcribing', 'analyzing');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_completion_rejected' USING ERRCODE = '55000';
  END IF;

  UPDATE public.episodes AS episode
  SET
    duration_seconds = p_source_duration_seconds,
    transcript_text = p_transcript_text,
    transcript_segments = p_transcript_segments,
    transcript_language = NULLIF(left(COALESCE(p_transcript_language, ''), 32), '')
  WHERE episode.id = v_job.episode_id
    AND episode.user_id = v_job.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'episode_completion_rejected' USING ERRCODE = '55000';
  END IF;

  UPDATE public.shorts_analysis_jobs AS job
  SET
    status = 'completed',
    completed_at = v_now,
    lease_token = NULL,
    lease_expires_at = NULL,
    error_message = NULL
  WHERE job.id = v_job.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.shorts_fail_analysis_job(
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
  v_job public.shorts_analysis_jobs%ROWTYPE;
  v_now timestamptz := now();
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

  UPDATE public.shorts_projects AS project
  SET
    status = 'failed',
    error_message = left(COALESCE(p_error_message, 'analysis_failed'), 400),
    completed_at = v_now,
    updated_at = v_now
  WHERE project.id = v_job.project_id
    AND project.user_id = v_job.user_id
    AND project.status IN ('queued', 'transcribing', 'analyzing');

  UPDATE public.shorts_analysis_jobs AS job
  SET
    status = 'failed',
    error_message = left(COALESCE(p_error_message, 'analysis_failed'), 400),
    completed_at = v_now,
    lease_token = NULL,
    lease_expires_at = NULL
  WHERE job.id = v_job.id;
  RETURN true;
END;
$$;

-- Selection is an atomic user decision, not a sequence of browser-writable
-- rows.  It rejects candidate ids outside the project and limits a batch to
-- twelve downstream renders.
CREATE OR REPLACE FUNCTION public.shorts_set_selected_candidates(
  p_user_id uuid,
  p_project_id uuid,
  p_candidate_ids uuid[],
  p_production_profile jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF jsonb_typeof(p_production_profile) IS DISTINCT FROM 'object'
    OR COALESCE(array_length(p_candidate_ids, 1), 0) < 1
    OR COALESCE(array_length(p_candidate_ids, 1), 0) > 12
    OR cardinality(p_candidate_ids) <> (
      SELECT count(DISTINCT selected_candidate_id)
      FROM unnest(p_candidate_ids) AS selection(selected_candidate_id)
    ) THEN
    RAISE EXCEPTION 'invalid_candidate_selection' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.shorts_projects AS project
  WHERE project.id = p_project_id
    AND project.user_id = p_user_id
    AND project.status = 'ready'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN -1;
  END IF;

  UPDATE public.shorts_candidates AS candidate
  SET selected = false, updated_at = now()
  WHERE candidate.project_id = p_project_id
    AND candidate.user_id = p_user_id
    AND candidate.selected = true;

  UPDATE public.shorts_candidates AS candidate
  SET
    selected = true,
    production_profile = p_production_profile,
    updated_at = now()
  WHERE candidate.project_id = p_project_id
    AND candidate.user_id = p_user_id
    AND candidate.id = ANY(p_candidate_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(p_candidate_ids) THEN
    RAISE EXCEPTION 'candidate_not_in_project' USING ERRCODE = '22023';
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.shorts_submit_analysis_job(uuid, uuid, text, integer, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_submit_analysis_job(uuid, uuid, text, integer, text, boolean, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.shorts_claim_analysis_job(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_claim_analysis_job(integer) TO service_role;
REVOKE ALL ON FUNCTION public.shorts_renew_analysis_lease(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_renew_analysis_lease(uuid, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.shorts_mark_analysis_analyzing(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_mark_analysis_analyzing(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.shorts_complete_analysis_job(uuid, uuid, text, text, text, text, jsonb, integer, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_complete_analysis_job(uuid, uuid, text, text, text, text, jsonb, integer, text, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.shorts_fail_analysis_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_fail_analysis_job(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.shorts_set_selected_candidates(uuid, uuid, uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_set_selected_candidates(uuid, uuid, uuid[], jsonb) TO service_role;

COMMENT ON TABLE public.shorts_analysis_jobs IS
  'Fenced, service-role-only queue for bounded long-form transcription and candidate analysis.';
COMMENT ON FUNCTION public.shorts_submit_analysis_job(uuid, uuid, text, integer, text, boolean, uuid) IS
  'Idempotently creates a 20 minute to two hour analysis project and its one queued analysis job; Jev transcript sharing is opt-in.';
COMMENT ON FUNCTION public.shorts_complete_analysis_job(uuid, uuid, text, text, text, text, jsonb, integer, text, jsonb, jsonb) IS
  'Atomically persists a fenced analysis result, full transcript, and validated candidate set.';
