// ============================================================================
// ClipsFlow Clips — Signature styles + palette
// ============================================================================
// 15 curated style presets — closed enum per `types.ts > STYLE_KEYS`.
// Each preset is rendered fully in-house via ffmpeg + libass.
//
// Ported from VidiaFlow src/lib/clipflow/subtitle-styles.ts (unchanged logic).
// Adaptation : import path `./subtitle-types` → `./types`.
// ============================================================================

import type { StyleKey, SubtitleCustomizations } from "./types";

export type StyleConfig = {
  key: StyleKey;
  display_name: string;
  display_description: string;
  preview_gif_url: string;
  defaults: SubtitleCustomizations & {
    font: string;
    text_color: string;
  };
};

export const SIGNATURE_STYLES: Record<StyleKey, StyleConfig> = {
  viral: {
    key: "viral",
    display_name: "Viral",
    display_description: "Optimisé TikTok/Reels/Shorts. Maximum engagement.",
    preview_gif_url: "/previews/clips-style-viral.gif",
    defaults: {
      font: "Inter Bold",
      text_color: "#FFFFFF",
      highlight_color: "#FFD700",
      font_size: "large",
      position_y: 75,
      emojis_auto: true,
    },
  },
  premium: {
    key: "premium",
    display_name: "Premium",
    display_description: "Optimisé YouTube/LinkedIn. Pro & B2B content.",
    preview_gif_url: "/previews/clips-style-premium.gif",
    defaults: {
      font: "Plus Jakarta Sans Medium",
      text_color: "#FFFFFF",
      background_color: "#000000",
      background_opacity: 85,
      font_size: "medium",
      position_y: 90,
      emojis_auto: false,
    },
  },
  hormozi: {
    key: "hormozi",
    display_name: "Hormozi",
    display_description:
      "Style Alex Hormozi. Bold condensed UPPERCASE, contour jaune.",
    preview_gif_url: "/previews/clips-style-hormozi.gif",
    defaults: {
      font: "Bebas Neue",
      text_color: "#FFFFFF",
      highlight_color: "#FFD700",
      font_size: "large",
      position_y: 75,
      emojis_auto: false,
    },
  },
  mrbeast: {
    key: "mrbeast",
    display_name: "MrBeast",
    display_description:
      "Style MrBeast. Black bold + contour épais, mots-clés verts.",
    preview_gif_url: "/previews/clips-style-mrbeast.gif",
    defaults: {
      font: "Montserrat Black",
      text_color: "#FFFFFF",
      highlight_color: "#34C759",
      font_size: "large",
      position_y: 75,
      emojis_auto: false,
    },
  },
  iman: {
    key: "iman",
    display_name: "Iman",
    display_description:
      "Style Iman Gadzhi. Lowercase épuré, blanc uni, lisible.",
    preview_gif_url: "/previews/clips-style-iman.gif",
    defaults: {
      font: "Plus Jakarta Sans Medium",
      text_color: "#FFFFFF",
      highlight_color: "#FFFFFF",
      font_size: "medium",
      position_y: 80,
      emojis_auto: false,
    },
  },
  minimal: {
    key: "minimal",
    display_name: "Minimal",
    display_description:
      "Sobre, B2B/podcast. Inter sans, blanc, animations zéro.",
    preview_gif_url: "/previews/clips-style-minimal.gif",
    defaults: {
      font: "Inter Bold",
      text_color: "#FFFFFF",
      highlight_color: "#FFFFFF",
      font_size: "medium",
      position_y: 90,
      emojis_auto: false,
    },
  },
  neon: {
    key: "neon",
    display_name: "Neon Glow",
    display_description:
      "Style néon. Glow cyan/magenta. Gaming, tech, cyberpunk.",
    preview_gif_url: "/previews/clips-style-neon.gif",
    defaults: {
      font: "Inter Bold",
      text_color: "#00FFFF",
      highlight_color: "#FF00FF",
      font_size: "large",
      position_y: 75,
      emojis_auto: false,
    },
  },
  typewriter: {
    key: "typewriter",
    display_name: "Typewriter",
    display_description:
      "Style machine à écrire. Apparition lettre par lettre.",
    preview_gif_url: "/previews/clips-style-typewriter.gif",
    defaults: {
      font: "Inter Bold",
      text_color: "#FFFFFF",
      highlight_color: "#FFFFFF",
      font_size: "medium",
      position_y: 80,
      emojis_auto: false,
    },
  },
  bounce: {
    key: "bounce",
    display_name: "Bounce",
    display_description: "Style TikTok bounce. Rebond vertical à l'entrée.",
    preview_gif_url: "/previews/clips-style-bounce.gif",
    defaults: {
      font: "Montserrat Black",
      text_color: "#FFFFFF",
      highlight_color: "#FFD700",
      font_size: "large",
      position_y: 75,
      emojis_auto: false,
    },
  },
  bar: {
    key: "bar",
    display_name: "Subtitle Bar",
    display_description: "Bandeau opaque type cinéma / podcast.",
    preview_gif_url: "/previews/clips-style-bar.gif",
    defaults: {
      font: "Inter Bold",
      text_color: "#FFFFFF",
      highlight_color: "#FFFFFF",
      font_size: "medium",
      position_y: 95,
      emojis_auto: false,
    },
  },
  cinematic: {
    key: "cinematic",
    display_name: "Cinematic",
    display_description: "Serif italique. Storytelling, lifestyle, doc.",
    preview_gif_url: "/previews/clips-style-cinematic.gif",
    defaults: {
      font: "DM Serif Display",
      text_color: "#FFFFFF",
      highlight_color: "#FFFFFF",
      font_size: "medium",
      position_y: 88,
      emojis_auto: false,
    },
  },

  // ── Wave 3 (2026-05-11) ────────────────────────────────────────────
  karaoke_pop: {
    key: "karaoke_pop",
    display_name: "Karaoke Pop",
    display_description: "Flash de couleur par mot. Effet Submagic.",
    preview_gif_url: "/previews/clips-style-karaoke-pop.gif",
    defaults: {
      font: "Inter Bold",
      text_color: "#FFFFFF",
      highlight_color: "#FFE600",
      font_size: "large",
      position_y: 75,
      emojis_auto: false,
    },
  },
  halo_glow: {
    key: "halo_glow",
    display_name: "Halo Glow",
    display_description: "Halo doux blanc chaud. Podcast premium.",
    preview_gif_url: "/previews/clips-style-halo-glow.gif",
    defaults: {
      font: "Plus Jakarta Sans Medium",
      text_color: "#F8F4E8",
      highlight_color: "#FFC88C",
      font_size: "medium",
      position_y: 50,
      emojis_auto: false,
    },
  },
  trailer_inferno: {
    key: "trailer_inferno",
    display_name: "Trailer Inferno",
    display_description: "Rouge-orange dramatique. Bande-annonce ciné.",
    preview_gif_url: "/previews/clips-style-trailer-inferno.gif",
    defaults: {
      font: "Anton",
      text_color: "#FFFFFF",
      highlight_color: "#FF3B00",
      font_size: "large",
      position_y: 75,
      emojis_auto: false,
    },
  },
  comic_bubble: {
    key: "comic_bubble",
    display_name: "Comic Bubble",
    display_description: "Pill opaque par ligne. Lifestyle ludique.",
    preview_gif_url: "/previews/clips-style-comic-bubble.gif",
    defaults: {
      font: "Poppins",
      text_color: "#FFFFFF",
      highlight_color: "#FF2D55",
      background_color: "#000000",
      background_opacity: 100,
      font_size: "large",
      position_y: 78,
      emojis_auto: false,
    },
  },
};

/**
 * Curated colour palette for restricted plan tiers. Tiers may pick a
 * `text_color` / `highlight_color` from this list ; any other hex is
 * dropped fail-closed by the tier-strip logic. Higher tiers get free-hex.
 */
export const PRO_COLOR_PALETTE = [
  "#FFD700", // gold
  "#FF3B30", // red
  "#34C759", // green
  "#007AFF", // blue
  "#AF52DE", // purple
  "#FF9500", // orange
  "#FFFFFF", // white
  "#000000", // black
] as const;

export type ProPaletteColor = (typeof PRO_COLOR_PALETTE)[number];

/**
 * Curated font list for plan-restricted tiers. Higher tiers may upload
 * a custom font and bypass this list.
 */
export const CURATED_FONTS = [
  "Inter Bold",
  "Plus Jakarta Sans Medium",
  "Roboto Black",
  "Montserrat Black",
  "Bebas Neue",
  "Anton",
  "Poppins",
  "Rubik",
  "DM Serif Display",
] as const;

export type CuratedFont = (typeof CURATED_FONTS)[number];
