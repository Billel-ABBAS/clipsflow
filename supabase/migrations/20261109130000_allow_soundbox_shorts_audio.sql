-- Add the open-source Soundbox provider without modifying historical audio rows.
-- Apply after confirming shorts_audio_assets is present and before enabling
-- CLIPS_SOUNDBOX_ENABLED on workers (and before sending paid user jobs).
ALTER TABLE public.shorts_audio_assets
  DROP CONSTRAINT IF EXISTS shorts_audio_assets_provider_check;

ALTER TABLE public.shorts_audio_assets
  ADD CONSTRAINT shorts_audio_assets_provider_check
  CHECK (provider IN ('elevenlabs', 'licensed_catalog', 'soundbox'));

COMMENT ON TABLE public.shorts_audio_assets IS
  'Private, server-created audio assets; new generations use Soundbox, historical ElevenLabs rows remain readable.';
