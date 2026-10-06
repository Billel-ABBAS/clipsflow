-- Close the read/write race if an expired lease overlaps its replacement.
-- A concurrent or stale worker may reuse the saved result, but cannot replace it.

CREATE OR REPLACE FUNCTION public.clips_store_shorts_creative_direction(
  p_job_id uuid,
  p_lease_token uuid,
  p_clip_id uuid,
  p_user_id uuid,
  p_input_hash text,
  p_model_id text,
  p_direction jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_existing jsonb;
BEGIN
  IF p_input_hash !~ '^[0-9a-f]{64}$'
    OR p_model_id <> 'claude-opus-5-5'
    OR jsonb_typeof(p_direction) IS DISTINCT FROM 'object'
  THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.jobs AS job
    WHERE job.id = p_job_id
      AND job.type = 'render'
      AND job.clip_id = p_clip_id
      AND job.user_id = p_user_id
      AND job.status = 'processing'
      AND job.lease_token = p_lease_token
      AND job.lease_expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RETURN false;
  END IF;

  SELECT clip.customizations #> '{shorts,creative_direction,cache}'
  INTO v_existing
  FROM public.clips AS clip
  WHERE clip.id = p_clip_id
    AND clip.user_id = p_user_id
    AND clip.status = 'processing';

  IF v_existing IS NOT NULL THEN
    RETURN v_existing ->> 'input_hash' = p_input_hash
      AND v_existing ->> 'model_id' = p_model_id
      AND jsonb_typeof(v_existing -> 'result') = 'object';
  END IF;

  UPDATE public.clips AS clip
  SET customizations = pg_catalog.jsonb_set(
    clip.customizations,
    '{shorts,creative_direction,cache}',
    pg_catalog.jsonb_build_object(
      'input_hash', p_input_hash,
      'model_id', p_model_id,
      'result', p_direction
    ),
    true
  )
  WHERE clip.id = p_clip_id
    AND clip.user_id = p_user_id
    AND clip.status = 'processing'
    AND clip.customizations #>> '{shorts,creative_direction,enabled}' = 'true'
    AND clip.customizations #>> '{shorts,creative_direction,explicit_consent}' = 'true'
    AND (clip.customizations #> '{shorts,creative_direction,cache}') IS NULL;

  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.clips_store_shorts_creative_direction(
  uuid, uuid, uuid, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clips_store_shorts_creative_direction(
  uuid, uuid, uuid, uuid, text, text, jsonb
) TO service_role;

COMMENT ON FUNCTION public.clips_store_shorts_creative_direction(
  uuid, uuid, uuid, uuid, text, text, jsonb
) IS
  'Stores a bounded Opus Shorts brief on its render only while the service worker holds the active fenced lease.';
