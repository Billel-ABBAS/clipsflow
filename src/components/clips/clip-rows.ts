// ============================================================================
// clip-rows — shared select-column list + row mapper for the clips gallery.
// Used by the two server pages (/clips and /clips/new) so the SELECT shape
// and the GalleryClipRow mapping stay in one place. No "use client" — this
// is shared server/client-agnostic code (type-only import from the gallery).
// ============================================================================

import type { GalleryClipRow } from "./ClipsGallery";

/** Raw select shape (incl. joined episode + storage paths for re-sign). */
export interface ClipRowRaw {
  id: string;
  episode_id: string;
  status: string;
  style_key: string | null;
  aspect_ratio: string | null;
  language: string | null;
  start_seconds: number;
  end_seconds: number;
  customizations: GalleryClipRow["customizations"];
  overlays: GalleryClipRow["overlays"];
  video_url: string | null;
  video_storage_path: string | null;
  thumbnail_url: string | null;
  thumbnail_storage_path: string | null;
  captions_vtt_url: string | null;
  captions_vtt_storage_path: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  score: number | null;
  episodes: { title: string | null } | null;
}

/** Column list for the gallery SELECT — includes the `*_storage_path`
 *  triplet consumed by refreshClipUrls() and the retry-seed fields
 *  (segment, language, customizations, overlays) consumed by
 *  RetryClipButton. */
export const CLIP_SELECT_COLUMNS =
  "id, episode_id, status, style_key, aspect_ratio, language, start_seconds, end_seconds, customizations, overlays, video_url, video_storage_path, thumbnail_url, thumbnail_storage_path, captions_vtt_url, captions_vtt_storage_path, error_message, created_at, completed_at, duration_seconds, score, episodes(title)";

/** Map a (URL-refreshed) raw row to the client gallery contract — drops
 *  the storage-path fields, which are internal to the re-sign helper. */
export function toGalleryRow(r: ClipRowRaw): GalleryClipRow {
  return {
    id: r.id,
    episode_id: r.episode_id,
    status: r.status as GalleryClipRow["status"],
    style_key: r.style_key,
    aspect_ratio: r.aspect_ratio,
    language: r.language,
    start_seconds: r.start_seconds,
    end_seconds: r.end_seconds,
    customizations: r.customizations ?? null,
    overlays: r.overlays ?? null,
    video_url: r.video_url,
    thumbnail_url: r.thumbnail_url,
    captions_vtt_url: r.captions_vtt_url,
    error_message: r.error_message,
    created_at: r.created_at,
    completed_at: r.completed_at,
    duration_seconds: r.duration_seconds,
    score: r.score,
    episode_title: r.episodes?.title ?? null,
  };
}
