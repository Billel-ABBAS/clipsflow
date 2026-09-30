-- Immutable audit trail for the AI-generated subtitle disclosure displayed in
-- every rendered clip.  This is intentionally server-only: the browser has no
-- need to enumerate a user's compliance evidence, and a client must never be
-- able to forge or erase it.
--
-- The unique key makes a resumed Railway job idempotent.  A second worker
-- attempt can observe the same render but cannot create a second disclosure
-- record for the same artefact/version.
CREATE TABLE IF NOT EXISTS public.ai_disclosure_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  clip_id uuid NOT NULL REFERENCES public.clips (id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (surface IN ('clip_subtitle')),
  disclosure_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_disclosure_events_clip_surface_version_key
    UNIQUE (clip_id, surface, disclosure_version)
);

ALTER TABLE public.ai_disclosure_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_disclosure_events FORCE ROW LEVEL SECURITY;

-- Explicitly revoke every exposed Data API role.  The service role bypasses
-- RLS but still receives a narrow explicit table grant for audit writes from
-- server routes and the Railway worker.
REVOKE ALL ON TABLE public.ai_disclosure_events FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_disclosure_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_disclosure_events
TO service_role;

CREATE INDEX IF NOT EXISTS idx_ai_disclosure_events_user_created_at
  ON public.ai_disclosure_events (user_id, created_at DESC);

COMMENT ON TABLE public.ai_disclosure_events IS
  'Server-only, idempotent audit evidence for required AI subtitle disclosure.';
