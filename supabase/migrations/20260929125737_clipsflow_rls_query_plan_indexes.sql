-- Supabase advisor follow-up: preserve the existing RLS semantics while
-- evaluating auth.uid() once per query, and cover the render-job foreign keys
-- used by clip/episode deletion and relationship lookups.

CREATE INDEX IF NOT EXISTS idx_jobs_clip_id
  ON public.jobs (clip_id)
  WHERE clip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_episode_id
  ON public.jobs (episode_id)
  WHERE episode_id IS NOT NULL;

ALTER POLICY "profiles_select_own"
  ON public.profiles
  USING ((SELECT auth.uid()) = id);

ALTER POLICY "profiles_update_own_nonsensitive"
  ON public.profiles
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

ALTER POLICY "episodes_select_own"
  ON public.episodes
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "clips_select_own"
  ON public.clips
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "jobs_select_own"
  ON public.jobs
  USING ((SELECT auth.uid()) = user_id);
