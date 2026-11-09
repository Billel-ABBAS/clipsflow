-- Add the self-hosted provider without rewriting historical audio or RLS.
-- Review and validate on ephemeral/staging Postgres before production.
ALTER TABLE public.shorts_audio_assets
  DROP CONSTRAINT shorts_audio_assets_provider_check,
  ADD CONSTRAINT shorts_audio_assets_provider_check
    CHECK (provider IN ('elevenlabs', 'licensed_catalog', 'open-audio'));
