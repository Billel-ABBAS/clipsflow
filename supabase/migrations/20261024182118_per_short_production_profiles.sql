-- Every selected Short owns an independent, bounded production profile. The
-- previous RPC is intentionally retained for already-deployed web clients;
-- the API switches to this profile-aware function atomically.
CREATE OR REPLACE FUNCTION public.shorts_set_selected_candidate_profiles(
  p_user_id uuid,
  p_project_id uuid,
  p_candidate_profiles jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF jsonb_typeof(p_candidate_profiles) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_candidate_profiles) < 1
    OR jsonb_array_length(p_candidate_profiles) > 12
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_candidate_profiles) AS selection(value)
      WHERE jsonb_typeof(selection.value) IS DISTINCT FROM 'object'
        OR NOT (selection.value ? 'candidate_id')
        OR jsonb_typeof(selection.value -> 'candidate_id') IS DISTINCT FROM 'string'
        OR (selection.value ->> 'candidate_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(selection.value -> 'production_profile') IS DISTINCT FROM 'object'
    )
    OR jsonb_array_length(p_candidate_profiles) <> (
      SELECT count(DISTINCT selection.value ->> 'candidate_id')
      FROM jsonb_array_elements(p_candidate_profiles) AS selection(value)
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
    production_profile = requested.production_profile,
    updated_at = now()
  FROM (
    SELECT
      (selection.value ->> 'candidate_id')::uuid AS candidate_id,
      selection.value -> 'production_profile' AS production_profile
    FROM jsonb_array_elements(p_candidate_profiles) AS selection(value)
  ) AS requested
  WHERE candidate.project_id = p_project_id
    AND candidate.user_id = p_user_id
    AND candidate.id = requested.candidate_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_candidate_profiles) THEN
    RAISE EXCEPTION 'candidate_not_in_project' USING ERRCODE = '22023';
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.shorts_set_selected_candidate_profiles(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shorts_set_selected_candidate_profiles(uuid, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.shorts_set_selected_candidate_profiles(uuid, uuid, jsonb) IS
  'Atomically persists a validated production profile per selected Shorts candidate; callable only by service_role.';
