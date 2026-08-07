// ============================================================================
// ClipsFlow Clips — preset bundles
// ============================================================================
// Each preset bundles a coherent set of form parameters. Click on a preset
// card on the clip creation UI hydrates the ClipStudio state in one shot.
//
// Ported from VidiaFlow src/lib/clipflow/preset-defaults.ts.
// Adaptations :
//   - `resolution` field REMOVED from all defaults (mono-tier 1080p only)
//   - Import path `./subtitle-types` → `./types`
//   - `Plan` type is defined inline below (local string literal union).
//     The profiles.plan column is wired in Phase 3 — not yet present in DB.
// ============================================================================

import type { AspectRatio, StyleKey, SubtitlePosition } from "./types";

// ClipsFlow plan tiers — string literal union matching the profiles.plan column.
type Plan = "free" | "creator" | "pro" | "studio" | "agency";

export type PresetCode =
  | "viral_tiktok"
  | "youtube_tutorial"
  | "hormozi_style"
  | "linkedin_pro"
  | "podcast_clip"
  | "gaming_stream"
  | "sports_highlight"
  | "interview_quote"
  | "cinematic_vlog"
  | "mrbeast_energy"
  | "karaoke_hit"
  | "custom";

/** Defines what one preset card unlocks when clicked. */
export interface PresetBundle {
  code: PresetCode;
  /** Emoji shown as the visual icon */
  icon: string;
  /** i18n keys ; resolved by the consumer with `useTranslations`. */
  nameKey: string;
  taglineKey: string;
  /** Lowest plan that can activate this preset. */
  requiredPlan: Plan;
  /** State hydration values. Undefined = leave the current state value alone. */
  defaults: {
    aspectRatio?: AspectRatio;
    styleKey?: StyleKey;
    position?: SubtitlePosition;
    /** Segment end timestamp in `mm:ss` format. Start always 00:00. */
    segmentEndTs?: string;
    /** Auto-enable the count-up overlay (Hormozi preset). */
    overlayCounter?: boolean;
    /** Auto-enable the CTA outro (LinkedIn Pro preset). */
    overlayCta?: boolean;
  };
}

export const PRESET_CARDS: PresetBundle[] = [
  {
    code: "viral_tiktok",
    icon: "🚀",
    nameKey: "presets.viral_tiktok.name",
    taglineKey: "presets.viral_tiktok.tagline",
    requiredPlan: "free",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "viral",
      position: "lower_third",
      segmentEndTs: "00:30",
    },
  },
  {
    code: "youtube_tutorial",
    icon: "🎓",
    nameKey: "presets.youtube_tutorial.name",
    taglineKey: "presets.youtube_tutorial.tagline",
    requiredPlan: "free",
    defaults: {
      aspectRatio: "16:9",
      styleKey: "minimal",
      position: "lower_third",
      segmentEndTs: "01:30",
    },
  },
  {
    code: "hormozi_style",
    icon: "🔥",
    nameKey: "presets.hormozi_style.name",
    taglineKey: "presets.hormozi_style.tagline",
    requiredPlan: "pro",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "hormozi",
      position: "lower_third",
      segmentEndTs: "00:30",
      overlayCounter: true,
    },
  },
  {
    code: "linkedin_pro",
    icon: "💼",
    nameKey: "presets.linkedin_pro.name",
    taglineKey: "presets.linkedin_pro.tagline",
    requiredPlan: "creator",
    defaults: {
      aspectRatio: "1:1",
      styleKey: "premium",
      position: "lower_third",
      segmentEndTs: "00:45",
      overlayCta: true,
    },
  },
  {
    code: "podcast_clip",
    icon: "🎙️",
    nameKey: "presets.podcast_clip.name",
    taglineKey: "presets.podcast_clip.tagline",
    requiredPlan: "creator",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "bar",
      position: "middle",
      segmentEndTs: "01:00",
    },
  },
  {
    code: "gaming_stream",
    icon: "🎮",
    nameKey: "presets.gaming_stream.name",
    taglineKey: "presets.gaming_stream.tagline",
    requiredPlan: "free",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "bounce",
      position: "lower_third",
      segmentEndTs: "00:45",
    },
  },
  {
    code: "sports_highlight",
    icon: "🏀",
    nameKey: "presets.sports_highlight.name",
    taglineKey: "presets.sports_highlight.tagline",
    requiredPlan: "pro",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "hormozi",
      position: "lower_third",
      segmentEndTs: "00:30",
      overlayCounter: true,
    },
  },
  {
    code: "interview_quote",
    icon: "💬",
    nameKey: "presets.interview_quote.name",
    taglineKey: "presets.interview_quote.tagline",
    requiredPlan: "creator",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "premium",
      position: "middle",
      segmentEndTs: "00:45",
    },
  },
  {
    code: "cinematic_vlog",
    icon: "🎬",
    nameKey: "presets.cinematic_vlog.name",
    taglineKey: "presets.cinematic_vlog.tagline",
    requiredPlan: "creator",
    defaults: {
      aspectRatio: "16:9",
      styleKey: "cinematic",
      position: "lower_third",
      segmentEndTs: "01:00",
    },
  },
  {
    code: "mrbeast_energy",
    icon: "🐐",
    nameKey: "presets.mrbeast_energy.name",
    taglineKey: "presets.mrbeast_energy.tagline",
    requiredPlan: "pro",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "mrbeast",
      position: "lower_third",
      segmentEndTs: "00:30",
      overlayCounter: true,
    },
  },
  {
    code: "karaoke_hit",
    icon: "🎵",
    nameKey: "presets.karaoke_hit.name",
    taglineKey: "presets.karaoke_hit.tagline",
    requiredPlan: "pro",
    defaults: {
      aspectRatio: "9:16",
      styleKey: "karaoke_pop",
      position: "lower_third",
      segmentEndTs: "00:30",
    },
  },
  {
    code: "custom",
    icon: "🎨",
    nameKey: "presets.custom.name",
    taglineKey: "presets.custom.tagline",
    requiredPlan: "free",
    defaults: {},
  },
];

/**
 * Plan ordering used to gate cards.
 */
const PLAN_ORDER: Record<Plan, number> = {
  free: 0,
  creator: 1,
  pro: 2,
  studio: 3,
  agency: 4,
};

export function isPresetAllowedForPlan(
  preset: PresetBundle,
  userPlan: Plan,
): boolean {
  return PLAN_ORDER[userPlan] >= PLAN_ORDER[preset.requiredPlan];
}

export function findPreset(code: PresetCode): PresetBundle {
  const found = PRESET_CARDS.find((p) => p.code === code);
  if (!found) throw new Error(`unknown preset code: ${code}`);
  return found;
}
