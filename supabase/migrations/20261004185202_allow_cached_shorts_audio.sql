-- Cached ElevenLabs tracks are private pipeline inputs stored beside rendered
-- outputs so workers can reuse them without another paid generation call.
-- Preserve an unrestricted bucket (NULL) and append only when this bucket is
-- explicitly MIME-restricted.
UPDATE storage.buckets
SET allowed_mime_types = array_append(allowed_mime_types, 'audio/mpeg')
WHERE id = 'clip-outputs'
  AND allowed_mime_types IS NOT NULL
  AND NOT ('audio/mpeg' = ANY(allowed_mime_types));
