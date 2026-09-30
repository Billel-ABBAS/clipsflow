import type { SupabaseClient } from "@supabase/supabase-js";

/** The visible surface carrying generated subtitle content. */
export const CLIP_SUBTITLE_DISCLOSURE_SURFACE = "clip_subtitle" as const;

/** Bump this when the user-facing disclosure implementation materially changes. */
export const CLIP_SUBTITLE_DISCLOSURE_VERSION = "ai-act-art-50-v1" as const;

export class ClipDisclosureError extends Error {
  readonly code = "disclosure_log_failed" as const;

  constructor() {
    super(
      "disclosure_log_failed: disclosure audit record could not be persisted",
    );
    this.name = "ClipDisclosureError";
  }
}

/**
 * Persist the compliance event associated with a completed subtitle render.
 *
 * No transcript, source URL, signed URL, or customer metadata is written. The
 * database uniqueness constraint makes this safe when a fenced worker resumes
 * after an interrupted completion attempt.
 */
export async function recordClipSubtitleDisclosure(
  supabase: SupabaseClient,
  input: { userId: string; clipId: string; locale: string },
): Promise<void> {
  const { error } = await supabase.from("ai_disclosure_events").upsert(
    {
      user_id: input.userId,
      clip_id: input.clipId,
      surface: CLIP_SUBTITLE_DISCLOSURE_SURFACE,
      disclosure_version: CLIP_SUBTITLE_DISCLOSURE_VERSION,
      metadata: {
        content_kind: "generated_subtitle_overlay",
        locale: input.locale,
        renderer: "railway",
      },
    },
    {
      onConflict: "clip_id,surface,disclosure_version",
      ignoreDuplicates: true,
    },
  );

  if (error) {
    // Do not bubble driver details into the job error column or platform logs.
    // The caller fails closed and its normal worker path cleans attempt files.
    throw new ClipDisclosureError();
  }
}
