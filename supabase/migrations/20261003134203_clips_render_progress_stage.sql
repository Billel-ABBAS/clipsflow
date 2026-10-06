-- Record the real upload/finalization phase without changing the canonical
-- jobs.status state machine. Only the current fenced Railway attempt can set
-- the phase; readers ignore markers from a previous attempt.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS render_stage text,
  ADD COLUMN IF NOT EXISTS render_stage_attempt_count integer;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_render_stage_allowed
    CHECK (render_stage IS NULL OR render_stage = 'completing'),
  ADD CONSTRAINT jobs_render_stage_attempt_positive
    CHECK (render_stage_attempt_count IS NULL OR render_stage_attempt_count > 0),
  ADD CONSTRAINT jobs_render_stage_attempt_pair
    CHECK ((render_stage IS NULL) = (render_stage_attempt_count IS NULL));

-- A retry and any terminal transition must remove the previous attempt's
-- progress marker. This keeps operational counts correct even before a
-- browser has refreshed and prevents obsolete stages accumulating in rows.
CREATE OR REPLACE FUNCTION public.clips_clear_render_progress_stage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status <> 'processing'
    OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count THEN
    NEW.render_stage := NULL;
    NEW.render_stage_attempt_count := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_clear_render_progress_stage ON public.jobs;
CREATE TRIGGER jobs_clear_render_progress_stage
  BEFORE UPDATE OF status, attempt_count ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.clips_clear_render_progress_stage();

CREATE OR REPLACE FUNCTION public.clips_mark_render_completing(
  p_job_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  UPDATE public.jobs AS job
  SET
    render_stage = 'completing',
    render_stage_attempt_count = job.attempt_count
  WHERE job.id = p_job_id
    AND job.type = 'render'
    AND job.status = 'processing'
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > v_now;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.clips_mark_render_completing(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_mark_render_completing(uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.clips_clear_render_progress_stage() FROM PUBLIC;

COMMENT ON FUNCTION public.clips_mark_render_completing(uuid, uuid) IS
  'Marks the current lease-fenced render attempt as uploading/finalizing; stale attempts cannot update progress.';
