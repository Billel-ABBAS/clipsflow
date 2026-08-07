// ============================================================================
// ClipsFlow Clips — TypeScript types
// ============================================================================
// Closed enums + row shapes for the `clips`, `episodes`, and `jobs` tables
// (migration 0002_clips_schema.sql) plus the customization payload shape
// consumed by the ClipStudio UI.
//
// Ported from VidiaFlow src/lib/clipflow/subtitle-types.ts.
// Key changes vs. source :
//   - ClipSubtitleJob → ClipJob (shape follows the `clips` table)
//   - Removed : BrandKit, brand_kit_id, video_id, resolution tiers
//               (2k/4k — mono-tier 1080p only), enqueue_mode (server only)
//   - Added : episode_id, start_seconds, end_seconds, score, hook_text
// ============================================================================

import type { OverlayElement } from "./overlays";

// 15-preset closed enum — identical to VidiaFlow STYLE_KEYS.
// The DB column `clips.style_key` carries a CHECK constraint in 0002_clips_schema.sql
// that lists exactly these 15 values. Keep both in sync when adding new styles.
export const STYLE_KEYS = [
  "viral",
  "premium",
  "hormozi",
  "mrbeast",
  "iman",
  "minimal",
  "neon",
  "typewriter",
  "bounce",
  "bar",
  "cinematic",
  // Wave 3 — 4 styles added 2026-05-11 in VidiaFlow, carried over as-is
  "karaoke_pop",
  "halo_glow",
  "trailer_inferno",
  "comic_bubble",
] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

// Industry-standard short-form aspect ratios.
export const ASPECT_RATIOS = ["9:16", "1:1", "4:5", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/**
 * Output frame dimensions per aspect ratio. Width capped at 1920 for the
 * landscape format, 1080 for portrait/square.
 * Order is `[width, height]`.
 */
export const ASPECT_RATIO_DIMENSIONS: Record<AspectRatio, [number, number]> = {
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "16:9": [1920, 1080],
};

// Statuts de la table `clips` — aligné CHECK 0002_clips_schema.sql (pending/processing/completing/completed/failed).
export const CLIP_STATUSES = [
  "pending",
  "processing",
  "completing",
  "completed",
  "failed",
] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

// Statuts de la table `jobs` (queue) — aligné CHECK 0002_clips_schema.sql, PAS de 'completing'.
// Le cron de drain écrit 'completed'.
export const QUEUE_JOB_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type QueueJobStatus = (typeof QUEUE_JOB_STATUSES)[number];

export const QUEUE_JOB_TYPES = [
  "transcribe",
  "clip_extract",
  "render",
] as const;
export type QueueJobType = (typeof QUEUE_JOB_TYPES)[number];

/** Row shape de la table `jobs` (0002_clips_schema.sql). */
export type QueueJob = {
  id: string;
  type: QueueJobType;
  user_id: string;
  episode_id: string | null;
  clip_id: string | null;
  payload: Record<string, unknown>;
  status: QueueJobStatus;
  attempt_count: number;
  claimed_at: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

/**
 * Subtitle vertical placement preset.
 *
 * Maps to ASS `Alignment` numpad (8=top-center, 5=middle-center, 2=bottom-center).
 */
export const SUBTITLE_POSITIONS = [
  "top",
  "middle",
  "lower_third",
  "bottom",
] as const;
export type SubtitlePosition = (typeof SUBTITLE_POSITIONS)[number];

/**
 * Subtitle styling overrides applied on top of a SIGNATURE_STYLES preset.
 * Each field is optional — server-side tier stripping decides which fields
 * the user's plan is allowed to set.
 */
export type SubtitleCustomizations = {
  text_color?: string;
  highlight_color?: string;
  background_color?: string;
  background_opacity?: number;
  font?: string;
  font_size?: "small" | "medium" | "large";
  /**
   * Vertical placement preset. Defaults to 'lower_third' server-side when
   * omitted. Maps to ASS Alignment + MarginV.
   */
  position?: SubtitlePosition;
  /**
   * Fine-tune offset 0-100 % from BOTTOM of frame. Overrides `position`
   * when both are sent (advanced wins).
   */
  position_y?: number;
  emojis_auto?: boolean;
  /**
   * Stroke / outline width in pixels (PlayResY=1080 reference). Range 0-12.
   */
  stroke_width?: number;
  /**
   * Auto-emphasise power-words (digits, currency, percent, exclamation,
   * ALL-CAPS) by re-colouring them with `highlight_color`.
   */
  auto_emphasis?: boolean;
  /**
   * Animation speed multiplier (0.5-2.0). Scales all time-based animation
   * values. 1.0 = preset default.
   */
  animation_speed?: number;
  /**
   * Per-word emphasis color cycle (max 5 hex). Successive power-words
   * rotate through the array (mod N).
   */
  emphasis_colors?: string[];
};

/**
 * Row shape for the `clips` table. `duration_seconds` is GENERATED ALWAYS
 * AS (end_seconds - start_seconds) STORED — never written by clients.
 */
export type ClipJob = {
  id: string;
  episode_id: string;
  user_id: string;
  start_seconds: number;
  end_seconds: number;
  /** GENERATED ALWAYS AS (end_seconds - start_seconds) STORED */
  duration_seconds: number;
  hook_text: string | null;
  score: number | null;
  status: ClipStatus;
  style_key: StyleKey;
  aspect_ratio: AspectRatio;
  language: string;
  customizations: SubtitleCustomizations;
  overlays: OverlayElement[];
  video_url: string | null;
  video_storage_path: string | null;
  thumbnail_url: string | null;
  thumbnail_storage_path: string | null;
  captions_vtt_url: string | null;
  captions_vtt_storage_path: string | null;
  cost_usd: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

// WordTimestamp — defined in whisper.ts (canonical location).
// Re-exported here so callers can import from a single types module.
export type { WordTimestamp } from "./whisper";
