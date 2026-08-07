// ============================================================================
// ClipsFlow Clips — signed-URL refresh helper for `clips` rows
// ============================================================================
// `video_url`, `captions_vtt_url`, and `thumbnail_url` are persisted with a
// 24h-TTL signed URL at render completion. Beyond 24h the gallery
// `<video src>` 403s and the user sees a broken tile.
//
// Pattern : pull the storage paths from the row, batch `createSignedUrls()`
// over the `clip-outputs` bucket, splice fresh signed URLs back into the row
// objects. Called in the gallery Server Component before rendering so the
// page never serves a stale URL.
//
// Re-signing is cheap (one Supabase call regardless of row count) — the
// gallery query is capped at 50 rows so the worst case is one batch of 150
// signed URLs (video + vtt + thumbnail, all in the same `clip-outputs`
// bucket). The 24h TTL is preserved on the re-sign so the browser bfcache
// can still hit during a session.
//
// Ported from VidiaFlow src/lib/clipflow/refresh-urls.ts.
// Adaptations : bucket `clip-subtitles` → `clip-outputs` ; column names
// output_* → video_*, poster_* → thumbnail_* (the `clips` table shape).
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "clip-outputs";

/**
 * Minimum shape — any object with the three URL fields + the three storage
 * path fields. Wider row shapes are preserved via the generic `T`. Storage
 * paths are nullable (thumbnail is always null in P1 ; vtt is best-effort).
 */
export interface ClipUrlFields {
  video_url?: string | null;
  captions_vtt_url?: string | null;
  thumbnail_url?: string | null;
  video_storage_path?: string | null;
  captions_vtt_storage_path?: string | null;
  thumbnail_storage_path?: string | null;
}

/**
 * Re-sign every `clip-outputs` storage path attached to each clip row.
 * Returns a new array — does not mutate inputs. Failures are silent : if
 * the batch call errors or a specific path isn't returned, the original
 * URL is preserved on the row (so rows with a non-null `video_url` but no
 * `video_storage_path` keep their old signed URL — still useful in the
 * < 24 h window).
 *
 * @param supabase  Server-side Supabase client (service role NOT required —
 *                  signed URL generation works through a regular client
 *                  because the bucket policy already gates list/select).
 * @param clips     Array of clip rows. Any row missing all three
 *                  `*_storage_path` fields is passed through untouched.
 * @param expiresIn Signed URL lifetime in seconds (default 24 h).
 */
export async function refreshClipUrls<T extends ClipUrlFields>(
  supabase: SupabaseClient,
  clips: T[],
  expiresIn = 86400,
): Promise<T[]> {
  if (clips.length === 0) return clips;

  // Collect every non-null storage path across the rows. Dedupe via Set —
  // unlikely to collide today (each path includes the clip UUID) but guards
  // against a future where two rows share an asset.
  const pathSet = new Set<string>();
  for (const c of clips) {
    if (c.video_storage_path) pathSet.add(c.video_storage_path);
    if (c.captions_vtt_storage_path) pathSet.add(c.captions_vtt_storage_path);
    if (c.thumbnail_storage_path) pathSet.add(c.thumbnail_storage_path);
  }
  const paths = Array.from(pathSet);
  if (paths.length === 0) return clips;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, expiresIn);

  // Soft-fail : if the bucket call errors, keep the old URLs. The page
  // shows whatever the DB had — better than wiping every URL.
  if (error || !data) return clips;

  const urlByPath = new Map<string, string>();
  for (const entry of data) {
    if (entry.path && entry.signedUrl) {
      urlByPath.set(entry.path, entry.signedUrl);
    }
  }

  return clips.map((c) => {
    const next = { ...c };
    if (c.video_storage_path) {
      const fresh = urlByPath.get(c.video_storage_path);
      if (fresh) next.video_url = fresh;
    }
    if (c.captions_vtt_storage_path) {
      const fresh = urlByPath.get(c.captions_vtt_storage_path);
      if (fresh) next.captions_vtt_url = fresh;
    }
    if (c.thumbnail_storage_path) {
      const fresh = urlByPath.get(c.thumbnail_storage_path);
      if (fresh) next.thumbnail_url = fresh;
    }
    return next;
  });
}
