// ============================================================================
// ClipsFlow Clips — ffmpeg subtitle burn helper
// ============================================================================
// ffmpeg supports the `subtitles` filter natively (libass), so we burn
// captions onto the source video without any browser involvement. The
// pipeline is CPU-only and fits serverless constraints (no Chromium, no
// Remotion, ~25 MB ffmpeg via @ffmpeg-installer/ffmpeg).
//
// Ported from VidiaFlow src/lib/clipflow/subtitle-burn.ts (2103 LOC).
// Surgical removals vs source :
//   - Brand-kit support (brandFont param + font staging + FONT_FAMILY_MAP
//     mutation) — ClipsFlow P1 has no brand_kits table.
//   - LUT 3D colour grading (STYLE_LUT_MAP + lut3d filter + enableLut3d
//     param) — out of P1 scope.
//   - Resolution tiers 2K/4K (RESOLUTION_TIER_SCALE) — mono-1080p ; output
//     dims come straight from ASPECT_RATIO_DIMENSIONS.
//   - Streaming output branch (_StreamingTarget / streamTo / pipe:1 args) —
//     rolled back in VidiaFlow PR #337 (4× slower in prod), dead code with
//     zero consumers ; the buffer-then-upload path is the only one kept.
//   - extractPosterFrame / poster logic — posters were removed upstream
//     2026-05-08 (HTML5 `#t=0.5` URL-fragment does it for free).
// Kept identical : ASS generation (via ass-format Lot 1), 15-style preset
// table, cue grouping + 2-pass dedup + 4 s cap, per-aspect PlayRes +
// playResScale retune, position / position_y resolution, animation_speed /
// stroke_width / background_opacity / auto_emphasis / emphasis_colors
// customizations, script-aware Noto font override, overlays (ASS layers +
// ffmpeg logo overlay incl. `brand_kit_logo_unavailable:` error prefix —
// prefix kept verbatim for cron routing even though only user overlays can
// produce logo plans in P1), SSRF guard on the dev fetch path + logo URLs,
// single-pass CRF libx264 ultrafast encode flags, buffer-then-upload.
//
// Fonts : staged from `fonts/` at the project root (process.cwd()) — the
// Inter.ttf catalogue is copied there in Lot 3. Best-effort : a missing
// dir logs a WARN and libass falls back to its default font.
// ============================================================================

import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { safeFetch } from "@/lib/utils/safe-fetch";
import {
  validateOutboundUrl,
  defaultClipsAllowedHosts,
  OutboundUrlError,
} from "@/lib/security/validate-outbound-url";
import type { WordTimestamp } from "./whisper";
import type { OverlayElement } from "./overlays";
import { buildOverlays } from "./overlays";
import { ASPECT_RATIO_DIMENSIONS } from "./types";
import { attachFfmpegTimeout } from "./ffmpeg-timeout";
import type { AspectRatio, StyleKey, SubtitleCustomizations } from "./types";
import {
  assTime,
  hexToAss,
  detectScriptFont,
  isKeyword,
  escapeAss,
  srtTime,
  vttTime,
} from "./ass-format";

// Re-export the canonical StyleKey so existing burn-helper consumers can
// keep a single import site (mirrors the source module's re-export).
export type { StyleKey } from "./types";

/**
 * Group consecutive words into 3-word phrases for SRT cues. Single-word
 * cues feel jittery on screen ; 3-word groups stay readable while still
 * tracking speech rhythm.
 */
export function buildSrt(words: WordTimestamp[], wordsPerCue = 3): string {
  if (words.length === 0) return "";
  const cues: string[] = [];
  let idx = 1;
  for (let i = 0; i < words.length; i += wordsPerCue) {
    const group = words.slice(i, i + wordsPerCue);
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const text = group.map((w) => w.text).join(" ");
    cues.push(`${idx}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`);
    idx++;
  }
  return cues.join("\n");
}

/**
 * Build a WebVTT string from word timestamps. Same 3-word grouping as
 * buildSrt — but emits W3C WebVTT format suitable for HTML5
 * `<track kind="captions" src=...>` integration.
 */
export function buildVtt(words: WordTimestamp[], wordsPerCue = 3): string {
  if (words.length === 0) return "WEBVTT\n\n";
  const lines: string[] = ["WEBVTT", ""];
  let idx = 1;
  for (let i = 0; i < words.length; i += wordsPerCue) {
    const group = words.slice(i, i + wordsPerCue);
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const text = group.map((w) => w.text).join(" ");
    lines.push(String(idx));
    lines.push(`${vttTime(start)} --> ${vttTime(end)}`);
    lines.push(text);
    lines.push("");
    idx++;
  }
  return lines.join("\n");
}

/**
 * Build a WebVTT string from pre-built display cues (translation path).
 * Same format as `buildVtt` but accepts already-grouped cues so we don't
 * lose translated phrasing. Used after translation merges words into
 * phrase-level cues — preserves the cue boundaries the translator chose.
 */
export function buildVttFromCues(
  cues: { text: string; start: number; end: number }[],
): string {
  if (cues.length === 0) return "WEBVTT\n\n";
  const lines: string[] = ["WEBVTT", ""];
  let idx = 1;
  for (const c of cues) {
    lines.push(String(idx));
    lines.push(`${vttTime(c.start)} --> ${vttTime(c.end)}`);
    lines.push(c.text);
    lines.push("");
    idx++;
  }
  return lines.join("\n");
}

/**
 * Per-style CRF map (dynamic CRF per style preset).
 *
 * - iman (lifestyle, minimal aesthetic deserves grain detail) → CRF 18
 * - hormozi / mrbeast (high-contrast, eyes drawn to text not gradients) → CRF 22
 * - everything else → CRF 20 (default)
 *
 * Lower CRF = higher quality + bigger file. The trade-off is informed
 * by the visual character of each preset, NOT a guess.
 *
 * Exported for reuse by `subtitle-burn-png-overlay.ts` (PNG overlay spike).
 */
export const STYLE_CRF_MAP: Record<StyleKey, number> = {
  iman: 18,
  hormozi: 22,
  mrbeast: 22,
  viral: 20,
  premium: 20,
  minimal: 20,
  cinematic: 20,
  neon: 20,
  typewriter: 20,
  bounce: 20,
  bar: 20,
  // Wave 3 styles — 20 = baseline visual quality for the burn target.
  // Halo Glow keeps a tighter CRF (19) since soft shadows benefit from
  // less compression noise around the glow halo edges.
  karaoke_pop: 20,
  halo_glow: 19,
  trailer_inferno: 20,
  comic_bubble: 20,
};

/**
 * Build the ffmpeg `crop=...,scale=...,setsar=1` filter prefix for a target
 * aspect ratio. Returns `""` when no ratio is supplied (legacy passthrough).
 *
 * Centre-crops the source to the target ratio then scales to the canonical
 * dimensions from `ASPECT_RATIO_DIMENSIONS`. The crop formula
 * `min(iw, ih*RATIO):min(ih, iw/RATIO)` picks the largest centred rectangle
 * of the target shape that fits inside the source — wider OR taller.
 *
 * Mono-1080p : the VidiaFlow `resolution` tier param (2K/4K multiplier) is
 * removed — output dims are the canonical table values (already even, so
 * libx264's even-dimension requirement holds).
 *
 * Exported for reuse by `subtitle-burn-png-overlay.ts` (PNG overlay spike).
 */
export async function aspectFilterFor(
  aspectRatio: AspectRatio | undefined,
  smartCropOffset: number | null = null,
): Promise<string> {
  if (!aspectRatio) return "";
  const [outW, outH] = ASPECT_RATIO_DIMENSIONS[aspectRatio];
  const [rw, rh] = aspectRatio.split(":").map(Number) as [number, number];
  const ratio = rw / rh;
  // `:flags=lanczos` resampler : the SaaS-grade standard for video
  // downscaling (used by YouTube / Vimeo / Facebook pipelines). Sharper
  // text + edges than ffmpeg's default `bicubic`, with negligible CPU
  // cost on libx264 ultrafast.
  // Smart-crop : when the saliency analysis returned a normalized
  // 0-1 offset (subject position from left edge), shift the crop X
  // accordingly. Otherwise fall back to ffmpeg's default centred crop
  // by omitting x,y entirely.
  if (
    smartCropOffset !== null &&
    smartCropOffset >= 0 &&
    smartCropOffset <= 1
  ) {
    // ffmpeg expects pixel coords. Compute crop window dims from the
    // ratio first, then the X offset clamped so the window stays
    // inside the source frame regardless of source size.
    const cropExpr =
      `crop=min(iw\\,ih*${ratio}):min(ih\\,iw/${ratio}):` +
      // x = clamp(round((iw - ow) * offset), 0, iw - ow)
      `min(max(round((iw-min(iw\\,ih*${ratio}))*${smartCropOffset.toFixed(4)})\\,0)\\,iw-min(iw\\,ih*${ratio})):` +
      // y = 0 (no vertical saliency in V1 — subjects are on the
      // horizontal axis 95 % of the time for talking-head + B-roll).
      `0`;
    return `${cropExpr},scale=${outW}:${outH}:flags=lanczos,setsar=1`;
  }
  return `crop=min(iw\\,ih*${ratio}):min(ih\\,iw/${ratio}),scale=${outW}:${outH}:flags=lanczos,setsar=1`;
}

/**
 * Build the libass force_style string for a given signature style + optional
 * tier-stripped customizations. Kept exported for test compat (the ASS file
 * path below carries the real styling ; force_style is a diagnostic
 * fallback artifact mirroring the source module).
 */
export function buildForceStyle(
  styleKey: StyleKey,
  custom?: {
    text_color?: string;
    highlight_color?: string;
    font?: string;
  },
): string {
  const isPremium = styleKey === "premium";
  const fontname = custom?.font ?? (isPremium ? "Inter" : "Bebas Neue");
  const fontsize = isPremium ? 32 : 48;
  const bold = isPremium ? 0 : -1;
  // Colors : convert #RRGGBB to ASS &H<BBGGRR>&
  const toAssColor = (hex: string | undefined, fallback: string): string => {
    const h = (hex ?? fallback).replace("#", "").padStart(6, "0").slice(-6);
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    return `&H${b}${g}${r}&`;
  };
  const primary = toAssColor(custom?.text_color, "FFFFFF");
  const outline = toAssColor(custom?.highlight_color, "000000");
  return [
    `Fontname=${fontname}`,
    `Fontsize=${fontsize}`,
    `PrimaryColour=${primary}`,
    `OutlineColour=${outline}`,
    `BorderStyle=1`,
    `Outline=3`,
    `Shadow=1`,
    `Bold=${bold}`,
    `Alignment=2`,
    `MarginV=80`,
  ].join(",");
}

export interface BurnSubtitlesParams {
  sourceVideoUrl: string;
  /**
   * Optional pre-fetched source bytes. When provided, the function skips
   * the network fetch and uses the buffer directly. Prefer `sourcePath`
   * for large sources : a buffer holds the whole MP4 in RAM.
   */
  sourceBuffer?: Buffer;
  /**
   * Optional pre-downloaded source file path. When provided, the function
   * skips both the network fetch AND the buffer-to-disk write — ffmpeg
   * reads directly from this path. The render worker always supplies this
   * (the /tmp segment). Takes precedence over `sourceBuffer` when both
   * are provided. Caller owns cleanup of this file.
   */
  sourcePath?: string;
  words: WordTimestamp[];
  /**
   * Optional pre-translated cues. When provided, `words` is ignored for cue
   * building — these cues are used verbatim. Timestamps are still adjusted
   * relative to clip start (same as words path).
   */
  preTranslatedCues?: { text: string; start: number; end: number }[];
  styleKey: StyleKey;
  startSec: number;
  endSec: number;
  /**
   * Tier-stripped styling overrides. The ClipsFlow worker passes the
   * `clips.customizations` payload (already stripped at submit time by
   * `stripCustomizationsByPlan`).
   */
  customizations?: SubtitleCustomizations;
  /**
   * Optional overlays composited on top of the caption track : title cards,
   * lower thirds, logo reveal. Rendered locally via ASS dialogue layers
   * (text overlays) + ffmpeg `overlay` filter (image overlays). See
   * `src/lib/clips/overlays.ts` for type definitions.
   */
  overlays?: OverlayElement[];
  /**
   * Target output aspect ratio. When set, the source frame is center-
   * cropped to the target ratio and rescaled to the canonical dimensions
   * from `ASPECT_RATIO_DIMENSIONS`. When omitted, the source ratio passes
   * through unchanged.
   */
  aspectRatio?: AspectRatio;
  /**
   * Saliency-based smart-crop X offset, normalized 0-1. When provided
   * and an aspect-ratio crop is active, ffmpeg shifts the crop window
   * horizontally so the subject stays centred. When `null` / undefined,
   * the symmetric center-crop kicks in. Computed by
   * `computeSmartCropOffset()` in `smart-crop.ts` ; caller decides
   * whether to invoke it.
   */
  smartCropOffset?: number | null;
}

export interface BurnSubtitlesResult {
  /** Final MP4 buffer (single-pass CRF H.264, AAC audio passthrough, BT.709 colour metadata). */
  mp4: Buffer;
  /** WebVTT sidecar string ready to upload as `<user_id>/<clip_id>.vtt`. */
  vtt: string;
}

/**
 * Trim the source to [startSec, endSec], burn subtitles via the ffmpeg
 * `subtitles` filter (libass + staged fonts), apply single-pass CRF H.264
 * encode + BT.709 colour metadata + 2-second keyframe interval. Returns
 * the rendered MP4 buffer + matching WebVTT sidecar.
 *
 * @throws if download or ffmpeg fails.
 */
export async function burnSubtitles(
  params: BurnSubtitlesParams,
): Promise<BurnSubtitlesResult> {
  const dir = await mkdtemp(join(tmpdir(), "pcsub-"));
  // When the caller threads `sourcePath` through (render worker — segment
  // already on /tmp), ffmpeg reads directly from that file ; we skip the
  // buffer-to-disk write entirely. Falls back to `sourceBuffer` or a
  // fresh fetch (dev / test paths).
  const inPath = params.sourcePath ?? join(dir, "in.mp4");
  const srtPath = join(dir, "captions.srt");
  const assPath = join(dir, "captions.ass");
  const outPath = join(dir, "out.mp4");
  try {
    // 1. Resolve source bytes — three modes :
    //    (a) `sourcePath` provided → ffmpeg reads from disk directly,
    //        no buffer load, no writeFile. Caller is responsible for
    //        cleanup.
    //    (b) `sourceBuffer` provided → buffer is written to a temp file.
    //    (c) Neither → fetch + arrayBuffer + write (dev / test path).
    if (!params.sourcePath) {
      let buf: Buffer;
      if (params.sourceBuffer) {
        buf = params.sourceBuffer;
      } else {
        // SSRF guard : the source URL may reach this branch only from
        // dev/test (the worker always supplies sourcePath). Still
        // validate against the Supabase Storage allowlist to keep this
        // branch consistent with run-job.ts. OutboundUrlError surfaces
        // as a thrown error — caller wraps it into `subtitle_burn_failed:`
        // in run-job.ts.
        try {
          validateOutboundUrl(params.sourceVideoUrl, {
            allowedHosts: defaultClipsAllowedHosts(),
          });
        } catch (err) {
          if (err instanceof OutboundUrlError) {
            throw new Error(`invalid_source_url: ${err.message}`);
          }
          throw err;
        }
        // 30 s timeout : a hanging upstream must not block the lambda up
        // to maxDuration without a typed error.
        const res = await safeFetch(params.sourceVideoUrl, {
          timeoutMs: 30_000,
          allowedHosts: defaultClipsAllowedHosts(),
        });
        if (!res.ok) {
          throw new Error(
            `Source download failed: HTTP ${res.status} ${res.statusText}`,
          );
        }
        buf = Buffer.from(await res.arrayBuffer());
      }
      await writeFile(inPath, buf);
    }

    // 2. Build display cues from either pre-translated cues or raw words.
    //    In both cases timestamps are adjusted relative to clip start.
    //    Source-words path preserves per-word timing so libass can render
    //    Submagic-style per-word karaoke highlight via ASS `\k` tags.
    const clipDuration = params.endSec - params.startSec;

    // 15-preset style table. Each entry encodes the visual identity of a
    // signature creator look : font, size, outline, shadow, animations,
    // text case, words-per-cue. Keeps ASS rendering parameters in one
    // place — easier to add new presets later without scattering
    // ternaries across 200 lines of code.
    type StylePreset = {
      defaultFont: string;
      fontsize: number;
      bold: 0 | -1;
      outlineWidth: number;
      shadowDepth: number;
      marginV: number;
      defaultSecondary: string;
      // 0 = no entrance animation ; otherwise initial scale % + duration ms
      popInScale: number;
      popInMs: number;
      // Bounce overshoot on entrance (Submagic / Klap / CapCut pattern) :
      // scale animates initial → 115 → 100 instead of initial → 100.
      popInOvershoot?: boolean;
      // Asymmetric fade : fade IN slow + OUT fast for snappy
      // disappearance. Both default to 150 / 80 ms. Override per preset
      // where the static-cinema feel needs balanced timing.
      fadeInMs?: number;
      fadeOutMs?: number;
      // "upper" | "lower" | "natural"
      textCase: "upper" | "lower" | "natural";
      wordsPerCue: number;
      // BorderStyle ASS field :
      //   1 = outline + drop shadow (default)
      //   3 = opaque box background (Comic Bubble pill)
      //   4 = opaque bar background (Subtitle Bar cinema)
      borderStyle: 1 | 3 | 4;
      // Optional ASS override block injected after `popInPrefix` on EVERY
      // cue. Used by `neon` for outline pulse glow ; defaults to "" for
      // every other preset.
      inlineOverrides?: string;
    };
    const STYLE_PRESETS: Record<StyleKey, StylePreset> = {
      viral: {
        defaultFont: "Inter",
        fontsize: 80,
        bold: -1,
        outlineWidth: 4,
        shadowDepth: 2,
        marginV: 120,
        defaultSecondary: "#FFD700",
        popInScale: 80,
        popInMs: 200,
        popInOvershoot: true,
        textCase: "upper",
        wordsPerCue: 3,
        borderStyle: 1,
      },
      premium: {
        defaultFont: "Plus Jakarta Sans",
        fontsize: 56,
        bold: 0,
        outlineWidth: 2,
        shadowDepth: 1,
        marginV: 100,
        defaultSecondary: "#FFFFFF",
        popInScale: 90,
        popInMs: 250,
        textCase: "natural",
        wordsPerCue: 5,
        borderStyle: 1,
      },
      hormozi: {
        defaultFont: "Bebas Neue",
        fontsize: 96,
        bold: -1,
        outlineWidth: 5,
        shadowDepth: 2,
        marginV: 110,
        defaultSecondary: "#FFD700",
        popInScale: 75,
        popInMs: 200,
        popInOvershoot: true,
        textCase: "upper",
        wordsPerCue: 3,
        borderStyle: 1,
      },
      mrbeast: {
        defaultFont: "Montserrat Black",
        fontsize: 88,
        bold: -1,
        outlineWidth: 8, // thick black stroke per MrBeast spec
        shadowDepth: 3,
        marginV: 120,
        defaultSecondary: "#34C759",
        popInScale: 70,
        popInMs: 180,
        popInOvershoot: true,
        textCase: "upper",
        wordsPerCue: 2, // 2 words per cue per MrBeast spec
        borderStyle: 1,
      },
      iman: {
        defaultFont: "Plus Jakarta Sans",
        fontsize: 64,
        bold: 0,
        outlineWidth: 0, // no stroke per Iman spec
        shadowDepth: 1,
        marginV: 100,
        defaultSecondary: "#FFFFFF",
        popInScale: 100, // no scale entrance — minimal motion
        popInMs: 0,
        textCase: "lower",
        wordsPerCue: 5,
        borderStyle: 1,
      },
      minimal: {
        defaultFont: "Inter",
        fontsize: 48,
        bold: 0,
        outlineWidth: 1,
        shadowDepth: 1,
        marginV: 90,
        defaultSecondary: "#FFFFFF",
        popInScale: 100, // no scale
        popInMs: 0,
        textCase: "natural",
        wordsPerCue: 6,
        borderStyle: 1,
      },
      // Neon — cyan text + magenta outline pulse glow. The outline alpha
      // pulses semi-transparent every 500 ms via `\3a` animation, emulating
      // neon flicker. Glow approximation : `\shad8` strong shadow. The
      // actual `\3c<secondary>` and `\shad` overrides are injected via
      // `inlineOverrides` so they fire on every cue.
      neon: {
        defaultFont: "Inter",
        fontsize: 84,
        bold: -1,
        outlineWidth: 6,
        shadowDepth: 4,
        marginV: 120,
        defaultSecondary: "#FF00FF",
        popInScale: 90,
        popInMs: 200,
        textCase: "upper",
        wordsPerCue: 3,
        borderStyle: 1,
        // \t(t1,t2,...) animates outline alpha &H00& (opaque) → &H80&
        // (50%) → &H00& over 1500 ms. Combined with \shad8 the rendered
        // text reads as glowing with a flicker pulse.
        inlineOverrides:
          "\\t(0,500,\\3a&H00&)\\t(500,1000,\\3a&H80&)\\t(1000,1500,\\3a&H00&)\\shad8",
      },
      // Typewriter — per-letter `\k` reveal (handled in cueToDialogue
      // where styleKey === "typewriter"). No pop-in / no fade so the
      // characters land in place sequentially.
      typewriter: {
        defaultFont: "Inter",
        fontsize: 64,
        bold: 0,
        outlineWidth: 2,
        shadowDepth: 0,
        marginV: 110,
        defaultSecondary: "#FFFFFF",
        popInScale: 100, // no scale entrance
        popInMs: 0,
        textCase: "upper",
        wordsPerCue: 4,
        borderStyle: 1,
      },
      // Bounce — aggressive scale bounce-in (50→100 over 250 ms) gives
      // the TikTok bounce feel via the existing animation pipeline.
      bounce: {
        defaultFont: "Montserrat Black",
        fontsize: 90,
        bold: -1,
        outlineWidth: 5,
        shadowDepth: 2,
        marginV: 120,
        defaultSecondary: "#FFD700",
        popInScale: 50,
        popInMs: 250,
        textCase: "upper",
        wordsPerCue: 2,
        borderStyle: 1,
      },
      // Bar — BorderStyle=4 emits an opaque box behind the text using the
      // Style's BackColour field (semi-transparent black). The box scales
      // with the text since libass repaints it per-cue.
      bar: {
        defaultFont: "Inter",
        fontsize: 56,
        bold: 0,
        outlineWidth: 0, // outline not used in BorderStyle=4 mode
        shadowDepth: 0,
        marginV: 100,
        defaultSecondary: "#FFFFFF",
        popInScale: 100,
        popInMs: 0,
        textCase: "natural",
        wordsPerCue: 5,
        borderStyle: 4, // opaque box (cinema / podcast subtitle bandeau)
      },
      // Cinematic — slow elegant fade, natural case, higher MarginV.
      // True serif via the bundled DM Serif Display.
      cinematic: {
        defaultFont: "DM Serif Display",
        fontsize: 56,
        bold: 0,
        outlineWidth: 1,
        shadowDepth: 1,
        marginV: 130,
        defaultSecondary: "#FFFFFF",
        popInScale: 100,
        popInMs: 0,
        textCase: "natural",
        wordsPerCue: 5,
        borderStyle: 1,
      },
      // ── Wave 3 ──────────────────────────────────────────────────
      // Karaoke Pop — per-word color flash via the existing `\k` karaoke
      // logic + yellow `defaultSecondary`. SHORT karaoke duration (faster
      // flash) + UPPERCASE + thick stroke + bounce overshoot.
      karaoke_pop: {
        defaultFont: "Inter Bold",
        fontsize: 80,
        bold: -1,
        outlineWidth: 6,
        shadowDepth: 4,
        marginV: 100,
        defaultSecondary: "#FFE600",
        popInScale: 92,
        popInMs: 160,
        popInOvershoot: true,
        fadeInMs: 100,
        fadeOutMs: 60,
        textCase: "upper",
        wordsPerCue: 3,
        borderStyle: 1,
      },
      // Halo Glow — soft warm white. Thick blurred shadow stack emulates
      // the outer glow (shadow depth=8 + outlineWidth=0 reads as halo).
      halo_glow: {
        defaultFont: "Plus Jakarta Sans Medium",
        fontsize: 64,
        bold: 0,
        outlineWidth: 0,
        shadowDepth: 8,
        marginV: 0,
        defaultSecondary: "#FFC88C",
        popInScale: 100,
        popInMs: 0,
        fadeInMs: 200,
        fadeOutMs: 200,
        textCase: "natural",
        wordsPerCue: 4,
        borderStyle: 1,
      },
      // Trailer Inferno — Hollywood movie dramatic. Anton condensed
      // UPPERCASE, red-orange highlight on emphasis words. Hard drop
      // shadow no blur (shadowDepth=6, outlineWidth=4 = thin stroke).
      trailer_inferno: {
        defaultFont: "Anton",
        fontsize: 88,
        bold: -1,
        outlineWidth: 4,
        shadowDepth: 6,
        marginV: 100,
        defaultSecondary: "#FF3B00",
        popInScale: 115,
        popInMs: 200,
        fadeInMs: 80,
        fadeOutMs: 80,
        textCase: "upper",
        wordsPerCue: 3,
        borderStyle: 1,
      },
      // Comic Bubble — BorderStyle=3 draws an opaque rectangle behind the
      // text (libass background box). BackColour=#000000 + Outline=0 keeps
      // the pill clean.
      comic_bubble: {
        defaultFont: "Poppins",
        fontsize: 64,
        bold: -1,
        outlineWidth: 0,
        shadowDepth: 0,
        marginV: 80,
        defaultSecondary: "#FF2D55",
        popInScale: 85,
        popInMs: 180,
        popInOvershoot: true,
        fadeInMs: 100,
        fadeOutMs: 100,
        textCase: "natural",
        wordsPerCue: 4,
        borderStyle: 3,
      },
      // ── End Wave 3 ──────────────────────────────────────────────
    };
    const preset = STYLE_PRESETS[params.styleKey] ?? STYLE_PRESETS.viral;
    const wordsPerCue = preset.wordsPerCue;

    type DisplayCue = {
      text: string;
      start: number;
      end: number;
      // When present, use per-word karaoke. Words timestamps are
      // already adjusted to clip-relative seconds.
      words?: { text: string; start: number; end: number }[];
    };

    let cues: DisplayCue[];

    if (params.preTranslatedCues && params.preTranslatedCues.length > 0) {
      // Pre-translated path : translation merged source words into a
      // single phrase per cue, so per-word karaoke is not available.
      // Still get fade-in/out animation via ASS `\fad` tag.
      cues = params.preTranslatedCues
        .filter((c) => c.end > params.startSec && c.start < params.endSec)
        .map((c) => ({
          text: c.text,
          start: Math.max(0, c.start - params.startSec),
          end: Math.min(clipDuration, c.end - params.startSec),
        }));
    } else {
      // Source-words path : keep per-word timestamps for karaoke.
      const adjusted = params.words
        .filter((w) => w.end > params.startSec && w.start < params.endSec)
        .map((w) => ({
          text: w.text,
          start: Math.max(0, w.start - params.startSec),
          end: Math.min(clipDuration, w.end - params.startSec),
        }));
      cues = [];
      for (let i = 0; i < adjusted.length; i += wordsPerCue) {
        const g = adjusted.slice(i, i + wordsPerCue);
        cues.push({
          text: g.map((w) => w.text).join(" "),
          start: g[0].start,
          end: g[g.length - 1].end,
          words: g,
        });
      }
      // SRT also written for diagnostic / fallback purposes.
      const srt = buildSrt(adjusted);
      await writeFile(srtPath, srt, "utf8");
    }

    // De-duplicate cues that visually repeat. Two failure modes seen in
    // production :
    //   (a) Consecutive cues with overlapping/identical text — Whisper
    //       repeats short phrases across cue boundaries.
    //   (b) Translation path emits the SAME phrase at distant timestamps
    //       (LLM translation drift on music-heavy / sparse-dialogue clips).
    //
    // Two-pass dedup :
    //   Pass 1 — drop consecutive overlapping repeats (substring match)
    //   Pass 2 — if a cue's normalised text already appeared anywhere
    //            in the cue stream within a generous 30-second window,
    //            drop the second occurrence (hallucination guard).
    const norm = (s: string): string =>
      s.trim().toLocaleLowerCase("fr-FR").replace(/\s+/g, " ");
    cues = cues.filter((c, i, arr) => {
      if (i === 0) return true;
      const prev = arr[i - 1];
      const a = norm(c.text);
      const b = norm(prev.text);
      const repeated = a === b || b.includes(a) || a.includes(b);
      const overlap = c.start < prev.end + 0.1;
      return !(repeated && overlap);
    });
    const seenWindow: { text: string; until: number }[] = [];
    cues = cues.filter((c) => {
      const key = norm(c.text);
      // Drop expired entries from the sliding window.
      while (seenWindow.length && seenWindow[0].until < c.start) {
        seenWindow.shift();
      }
      // If we already saw this normalised text within the last 30 s,
      // skip — likely a translation hallucination repeat.
      if (seenWindow.some((w) => w.text === key)) return false;
      seenWindow.push({ text: key, until: c.end + 30 });
      return true;
    });

    // Cap any single cue's display duration. Submagic / CapCut cap at
    // 3-4 s ; longer cues feel "stuck" on screen. We use 4 s — enough
    // for a complete short phrase, short enough to keep the rhythm.
    const MAX_CUE_DURATION = 4;
    cues = cues.map((c) => ({
      ...c,
      end: Math.min(c.end, c.start + MAX_CUE_DURATION),
    }));

    // 3. Industry-standard pipeline : libass with ASS dialogue file
    //    (vs SRT) so we get the full ASS feature set : per-word karaoke
    //    highlight (`\k`), fade-in/out (`\fad`), inline color overrides,
    //    and a shared style block that scales to any output resolution
    //    via PlayResX/PlayResY.

    // (a) Stage all curated TTFs into the temp dir so fontsdir resolves
    //     from any cwd. The catalogue lives in `fonts/` at the project
    //     root (Inter.ttf copied in Lot 3 ; more fonts as they land).
    const FONT_FAMILY_MAP: Record<string, string> = {
      "Inter.ttf": "Inter",
      "Inter Bold": "Inter",
      "BebasNeue.ttf": "Bebas Neue",
      "Bebas Neue": "Bebas Neue",
      "PlusJakartaSans.ttf": "Plus Jakarta Sans",
      "Plus Jakarta Sans Medium": "Plus Jakarta Sans",
      "Plus Jakarta Sans": "Plus Jakarta Sans",
      "RobotoBlack.ttf": "Roboto Black",
      "Roboto Black": "Roboto Black",
      "MontserratBlack.ttf": "Montserrat Black",
      "Montserrat Black": "Montserrat Black",
      "Anton-Regular.ttf": "Anton",
      Anton: "Anton",
      "Poppins-Bold.ttf": "Poppins",
      Poppins: "Poppins",
      "Rubik-Variable.ttf": "Rubik",
      Rubik: "Rubik",
      "DMSerifDisplay-Regular.ttf": "DM Serif Display",
      "DM Serif Display": "DM Serif Display",
      // Script-specific Noto Sans fallbacks. These are NOT meant to be
      // selected as primary fontFamily — instead the per-cue `\fn`
      // override (detectScriptFont) forces the matching family when the
      // cue's dominant script needs it, AS LONG AS the .ttf/.otf files
      // are present in the fontsdir staging path.
      "NotoSans-Bold.ttf": "Noto Sans",
      "Noto Sans": "Noto Sans",
      "NotoSansArabic-Bold.ttf": "Noto Sans Arabic",
      "Noto Sans Arabic": "Noto Sans Arabic",
      "NotoSansHebrew-Bold.ttf": "Noto Sans Hebrew",
      "Noto Sans Hebrew": "Noto Sans Hebrew",
      "NotoSansThai-Bold.ttf": "Noto Sans Thai",
      "Noto Sans Thai": "Noto Sans Thai",
      "NotoSansDevanagari-Bold.ttf": "Noto Sans Devanagari",
      "Noto Sans Devanagari": "Noto Sans Devanagari",
      "NotoSansSC-Bold.otf": "Noto Sans SC",
      "Noto Sans SC": "Noto Sans SC",
      "NotoSansJP-Bold.otf": "Noto Sans JP",
      "Noto Sans JP": "Noto Sans JP",
      "NotoSansKR-Bold.otf": "Noto Sans KR",
      "Noto Sans KR": "Noto Sans KR",
      // Emoji color font — libass on Linux Lambda has NO emoji glyphs in
      // the default font set ; without a colour-emoji font in fontsdir,
      // emoji render as tofu boxes (▢).
      "NotoColorEmoji.ttf": "Noto Color Emoji",
      "Noto Color Emoji": "Noto Color Emoji",
    };
    const fontsSourceDir = resolve(process.cwd(), "fonts");
    let stagedCount = 0;
    try {
      const files = readdirSync(fontsSourceDir).filter((f) => {
        const lower = f.toLowerCase();
        return lower.endsWith(".ttf") || lower.endsWith(".otf");
      });
      for (const f of files) {
        try {
          const srcBuf = await readFile(join(fontsSourceDir, f));
          await writeFile(join(dir, f), srcBuf);
          stagedCount++;
        } catch {
          // best-effort — one missing font shouldn't block the burn
        }
      }
    } catch (err) {
      console.log(
        `[clips-burn] WARN font dir staging failed (${(err as Error).message.slice(0, 100)}) — libass will fall back to default font`,
      );
    }

    // Resolve user-requested font (raw key from customizations) → ASS
    // family name. Fall back to the preset default if missing.
    const requestedFontKey = params.customizations?.font ?? "";
    const fontFamily = FONT_FAMILY_MAP[requestedFontKey] ?? preset.defaultFont;

    // (b) Style preset. Sizes are in PlayRes coordinates so they scale
    //     proportionally to any output resolution.
    //
    // PlayResY-relative scaling : presets were historically tuned for
    // PlayResY=1080. With per-aspect PlayRes (9:16 → 1920, 4:5 → 1350,
    // 1:1 → 1080, 16:9 → 1080), the visual size of fontsize=80 shrinks
    // relative to vertical extent on tall aspects without compensation.
    //
    // Strategy : multiply fontsize / outlineWidth / shadowDepth / marginV
    // by `playResY / 1080` so visual weight + positioning stay consistent
    // across aspects. Animation timing (popInMs, fadeInMs, fadeOutMs)
    // stays constant — only the spatial dimensions scale.
    const aspectForPlayRes = params.aspectRatio ?? "16:9";
    const [playResX, playResY] = ASPECT_RATIO_DIMENSIONS[aspectForPlayRes];
    const playResScale = playResY / 1080;
    const fontsize = Math.round(preset.fontsize * playResScale);
    const bold = preset.bold; // ASS bold flag (-1=true, 0=false)
    // Studio+ stroke_width override (0-12 px). When provided, replaces
    // the per-style outline. Tier-strip clamps to [0,12] server-side
    // so the value is always safe here.
    const customStroke = params.customizations?.stroke_width;
    const outlineWidth = Math.round(
      (typeof customStroke === "number" ? customStroke : preset.outlineWidth) *
        playResScale,
    );
    const shadowDepth = Math.round(preset.shadowDepth * playResScale);

    // Resolve subtitle position from customizations. Maps to ASS numpad
    // alignment + per-position MarginV. Falls back to the per-style preset
    // default when no position customization is supplied. `position_y`
    // (0-100 % from bottom) fine-tune overrides `position` when both are
    // present.
    //
    // ASS Alignment numpad layout (PlayResY=1080 reference) :
    //    7 8 9      (top row)
    //    4 5 6      (middle row)
    //    1 2 3      (bottom row)
    // We keep horizontal alignment centered (2 / 5 / 8). MarginV is in
    // PlayRes pixels. All literal constants below (80, 410, 200) were
    // tuned for PlayResY=1080 — scale by playResScale so positioning
    // stays at the same proportional location on tall aspects.
    let alignment = 2;
    let marginV = Math.round(preset.marginV * playResScale);
    const posPreset = params.customizations?.position;
    if (posPreset === "top") {
      alignment = 8;
      marginV = Math.round(80 * playResScale);
    } else if (posPreset === "middle") {
      alignment = 5;
      marginV = 0;
    } else if (posPreset === "lower_third") {
      // Sweet spot ~62 % from top on a 1080p PlayResY. Anchored
      // bottom-center (alignment=2) with marginV=410 → text bottom
      // edge sits ~38 % from frame bottom = ~62 % from top. Validated
      // against TikTok / Shorts / Reels safe-zone research (caption-safe
      // band 15 %–65 % universally clear).
      alignment = 2;
      marginV = Math.round(410 * playResScale);
    } else if (posPreset === "bottom") {
      alignment = 2;
      marginV = Math.round(80 * playResScale);
    }
    const posY = params.customizations?.position_y;
    if (typeof posY === "number" && posY >= 0 && posY <= 100) {
      // 0 = bottom edge → MarginV 0 ; 100 = top edge → MarginV near
      // PlayResY * 0.95. For middle (~50 %) we anchor middle-center
      // (Alignment=5) with MarginV=0 to stay perfectly centered.
      const scaledTravel = 200 * playResScale;
      if (posY < 33) {
        alignment = 2;
        marginV = Math.round((posY / 33) * scaledTravel);
      } else if (posY > 66) {
        alignment = 8;
        marginV = Math.round(((100 - posY) / 34) * scaledTravel);
      } else {
        alignment = 5;
        marginV = 0;
      }
    }
    // PrimaryColour = base text fill BEFORE karaoke advance.
    // SecondaryColour = post-karaoke fill (the spoken word's colour).
    const primaryHex = params.customizations?.text_color ?? "#FFFFFF";
    const secondaryHex =
      params.customizations?.highlight_color ?? preset.defaultSecondary;
    const outlineHex = "#000000";
    const primaryAss = hexToAss(primaryHex, "FFFFFF");
    const secondaryAss = hexToAss(secondaryHex, "FFFFFF");
    const outlineAss = hexToAss(outlineHex, "000000");

    // Studio+ background_opacity slider override (0-100). ASS BackColour
    // alpha is INVERTED : 0x00 = fully opaque, 0xFF = fully transparent.
    // Formula : alpha = round((100 - opacity) / 100 * 255).
    // Only meaningful when BorderStyle is 3 (pill) or 4 (bar) — for
    // other styles the BackColour field is ignored by libass so this
    // value is harmless. When omitted, fall back to the legacy default
    // &H80000000& (50 % black).
    const customBgOpacity = params.customizations?.background_opacity;
    const backColourAss =
      typeof customBgOpacity === "number"
        ? `&H${Math.round(((100 - customBgOpacity) / 100) * 255)
            .toString(16)
            .padStart(2, "0")
            .toUpperCase()}000000&`
        : "&H80000000&";

    // (c) Build ASS file. PlayRes pinned to the 1080p-equivalent OUTPUT
    //     aspect (libass convention : keep the design surface at "1080p
    //     worth of design pixels", just match aspect to the output frame).
    //
    //     Per-aspect PlayRes :
    //       - 16:9 → 1920×1080
    //       - 9:16 → 1080×1920
    //       - 1:1  → 1080×1080
    //       - 4:5  → 1080×1350
    //
    //     `ScaledBorderAndShadow: yes` ensures outline + shadow scale
    //     proportionally with the surface so visual weight stays
    //     consistent across aspects.
    const assHeader = [
      "[Script Info]",
      "ScriptType: v4.00+",
      `PlayResX: ${playResX}`,
      `PlayResY: ${playResY}`,
      "ScaledBorderAndShadow: yes",
      "WrapStyle: 0", // smart wrap : break on space, balance lines
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,${fontFamily},${fontsize},${primaryAss},${secondaryAss},${outlineAss},${backColourAss},${bold},0,0,0,100,100,2,0,${preset.borderStyle},${outlineWidth},${shadowDepth},${alignment},80,80,${marginV},1`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ].join("\n");

    // Pop-in scale entrance animation (CapCut / Submagic signature) —
    // text starts at popInScale% and grows to 100% over popInMs.
    //   1. Asymmetric fade : fade IN slow (150 ms) + OUT fast (80 ms)
    //      for snappy disappearance. Defaults below ; preset can override
    //      via fadeInMs / fadeOutMs.
    //   2. Bounce overshoot : overshoot to ~115 % then settle to 100 %.
    //      Toggled per preset via `popInOvershoot`.
    //
    // typewriter emits NO entrance prefix — the per-letter `\k` reveal
    // IS the entrance. popInMs === 0 means no scale animation (iman /
    // minimal) → fade only.
    //
    // Studio+ animation_speed slider 0.5-2.0× multiplier. Scales every
    // time-based animation value (popInMs, fade-in/out, settle delay)
    // proportionally. Range clamped server-side by tier-strip.
    const animationSpeed = Math.max(
      0.5,
      Math.min(2, params.customizations?.animation_speed ?? 1),
    );
    // Higher speed = SHORTER duration values → divide by multiplier.
    const speedScale = (ms: number) =>
      Math.max(1, Math.round(ms / animationSpeed));

    const fadeIn = speedScale(preset.fadeInMs ?? 150);
    const fadeOut = speedScale(preset.fadeOutMs ?? 80);
    const overshootScale = 115;
    const overshootSettleMs = speedScale(100);
    const scaledPopInMs = speedScale(preset.popInMs);
    const popInBody =
      params.styleKey === "typewriter"
        ? ""
        : preset.popInMs === 0
          ? `\\fad(${fadeIn},${fadeOut})`
          : preset.popInOvershoot
            ? `\\fad(${fadeIn},${fadeOut})\\fscx${preset.popInScale}\\fscy${preset.popInScale}\\t(0,${scaledPopInMs},\\fscx${overshootScale}\\fscy${overshootScale})\\t(${scaledPopInMs},${scaledPopInMs + overshootSettleMs},\\fscx100\\fscy100)`
            : `\\fad(${fadeIn},${fadeOut})\\fscx${preset.popInScale}\\fscy${preset.popInScale}\\t(0,${scaledPopInMs},\\fscx100\\fscy100)`;
    // Neon : the outline pulse override needs the secondary colour
    // resolved at runtime (BGR ASS form), so we splice it in here rather
    // than hardcoding it in the preset table. Other presets just use the
    // static `inlineOverrides` value verbatim.
    const inlineRaw = preset.inlineOverrides ?? "";
    const inline =
      params.styleKey === "neon"
        ? `\\3c${secondaryAss}${inlineRaw}`
        : inlineRaw;
    const popInPrefix =
      popInBody.length === 0 && inline.length === 0
        ? ""
        : `{${popInBody}${inline}}`;

    // Text case per preset : viral / hormozi / mrbeast = UPPERCASE,
    // iman = lowercase (his signature look), premium / minimal = natural
    // case. UPPERCASE uses Intl-aware accent-safe transform for FR.
    const transformText = (s: string): string => {
      switch (preset.textCase) {
        case "upper":
          return s.toLocaleUpperCase("fr-FR");
        case "lower":
          return s.toLocaleLowerCase("fr-FR");
        case "natural":
        default:
          return s;
      }
    };

    /**
     * Build an ASS Dialogue line for a cue.
     * - `popInPrefix` wraps the whole line in fade + scale-pop entrance.
     * - When per-word timestamps are available (source-words path),
     *   emits `\k<centisec>` per word for Submagic-style karaoke
     *   highlight.
     * - When only phrase-level timing is available (translation path),
     *   we synthesise per-word `\k` by distributing cue duration evenly
     *   across split words.
     */
    // MrBeast green-keyword colour override. Wrap each detected keyword
    // with `\1c<green>&...\1c<primary>&` so the word renders green on
    // top of the karaoke `\k` advance. Detection runs on the ORIGINAL-case
    // word before transformText() is applied, otherwise the all-caps rule
    // matches 100 % of the words.
    //
    // Limitation : on the synthesised translation path (no `c.words`),
    // the cue text has already been transformText()'d — original case is
    // lost — so we skip the keyword override there.
    const isMrBeast = params.styleKey === "mrbeast";
    const isTypewriter = params.styleKey === "typewriter";
    const greenAss = hexToAss("#34C759", "34C759");
    const cueToDialogue = (c: DisplayCue): string => {
      const start = assTime(c.start);
      const end = assTime(c.end);
      let body: string;
      if (isTypewriter) {
        // Typewriter — distribute per-character `\k` across the cue
        // duration so letters appear sequentially. libass `\k` per-letter
        // is heavy on the parser ; cues stay short (wordsPerCue=4).
        const display = transformText(c.text);
        const chars = [...display]; // unicode-aware split
        if (chars.length === 0) {
          body = "";
        } else {
          const totalCs = Math.max(
            chars.length,
            Math.round((c.end - c.start) * 100),
          );
          const perChar = Math.max(1, Math.floor(totalCs / chars.length));
          body = chars
            .map((ch) => {
              // Spaces use a snappier 0 cs so the rhythm matches words,
              // not raw character count.
              const ks = ch === " " ? 0 : perChar;
              return `{\\k${ks}}${escapeAss(ch)}`;
            })
            .join("");
        }
      } else if (c.words && c.words.length > 0) {
        // `auto_emphasis` extends the MrBeast green highlight to any
        // style, using the user's highlight_color instead of green.
        const autoEmphasis = params.customizations?.auto_emphasis === true;
        const emphasisAss = autoEmphasis ? secondaryAss : greenAss;
        // Per-word emphasis color cycle. When present + length ≥1,
        // rotates through these hex colors instead of using the single
        // emphasisAss. Counter increments per power-word match.
        const cycle = params.customizations?.emphasis_colors;
        const cycleAss =
          Array.isArray(cycle) && cycle.length > 0
            ? cycle.map((h) => hexToAss(h, "FFFFFF"))
            : null;
        let emphasisCount = 0;
        body = c.words
          .map((w) => {
            const cs = Math.max(1, Math.round((w.end - w.start) * 100));
            const escaped = escapeAss(transformText(w.text));
            const shouldHighlight =
              (isMrBeast || autoEmphasis) && isKeyword(w.text);
            let wrapped = escaped;
            if (shouldHighlight) {
              const colorAss = cycleAss
                ? cycleAss[emphasisCount % cycleAss.length]
                : emphasisAss;
              wrapped = `{\\1c${colorAss}}${escaped}{\\1c${primaryAss}}`;
              emphasisCount++;
            }
            return `{\\k${cs}}${wrapped}`;
          })
          .join(" ");
      } else {
        // Synthesise per-word karaoke from a phrase by even time
        // distribution. Better than no karaoke (the spoken-word colour
        // pop is the most-noticed wow effect).
        // NOTE: keyword green skipped on this path — the cue.text was
        // already case-transformed when this branch fires (translation
        // path), so isKeyword's all-caps rule would match every word.
        const tokens = c.text.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
          body = "";
        } else {
          const totalCs = Math.max(
            tokens.length,
            Math.round((c.end - c.start) * 100),
          );
          const perWord = Math.max(1, Math.floor(totalCs / tokens.length));
          body = tokens
            .map((t) => `{\\k${perWord}}${escapeAss(transformText(t))}`)
            .join(" ");
        }
      }
      // Script-aware font override : detect dominant Unicode script in
      // the cue text and force the matching Noto Sans family via `\fn`.
      // Without this, Arabic / CJK / Thai / Hebrew / Devanagari render
      // as tofu boxes on Linux Lambda (libass per-glyph auto-fallback
      // requires fontconfig indexing which doesn't apply to our staged
      // tmpdir fonts).
      const scriptFont = detectScriptFont(c.text);
      const fontPrefix = scriptFont ? `{\\fn${scriptFont}}` : "";
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${popInPrefix}${fontPrefix}${body}`;
    };

    // Overlays : title cards, lower thirds, logo reveal. Title cards +
    // lower thirds are emitted as additional ASS Dialogue lines on layers
    // 1-2 (above caption layer 0). Logo reveals are rendered via ffmpeg
    // `overlay` filter — see filterStr build below.
    const overlayResult = buildOverlays(
      params.overlays,
      clipDuration,
      fontFamily,
    );

    const assBody =
      assHeader +
      "\n" +
      cues.map(cueToDialogue).join("\n") +
      (overlayResult.assDialogues.length > 0
        ? "\n" + overlayResult.assDialogues.join("\n")
        : "") +
      "\n";
    await writeFile(assPath, assBody, "utf8");

    // (d) Filter args. ASS file path needs `\` → `/` and `:` → `\:`
    //     escaping (POSIX paths on Lambda are no-ops). Use `subtitles=`
    //     filter (libass-backed).
    const escapeFilterPath = (p: string) =>
      p.replace(/\\/g, "/").replace(/:/g, "\\:");
    const assForFilter = escapeFilterPath(assPath);
    const fontsDirForFilter = escapeFilterPath(dir);

    // Logo overlay branch : if any LogoReveal elements were collected,
    // download each PNG to the temp dir, prepend `-i logo.png` flags,
    // and chain `overlay` filters BEFORE the `subtitles` filter so the
    // captions still render on top of the composited frame.
    const logoInputArgs: string[] = [];
    const logoFilterChunks: string[] = [];
    let inputIdx = 1; // 0 is the source video
    for (const plan of overlayResult.logoPlans) {
      // When a logoPlan is in this list, the user explicitly supplied a
      // logo overlay. Fetch failure means they'd receive a logo-less clip
      // with no error signal. Throw a recoverable error with the
      // `brand_kit_logo_unavailable:` prefix — kept VERBATIM from the
      // VidiaFlow source so the cron worker error routing stays
      // compatible (brand kits themselves are not ported in P1 ; user
      // overlays are the only producer of logo plans).
      try {
        // SSRF guard : the logo URL is user-controllable via the
        // clips.overlays payload. Validate against the Supabase Storage
        // allowlist before fetching — defense in depth. OutboundUrlError
        // is caught by the outer try block and re-wrapped with the
        // `brand_kit_logo_unavailable:` prefix so the cron worker refunds
        // quota like any other logo failure.
        try {
          validateOutboundUrl(plan.logoUrl, {
            allowedHosts: defaultClipsAllowedHosts(),
          });
        } catch (err) {
          if (err instanceof OutboundUrlError) {
            throw new Error(
              `brand_kit_logo_unavailable: Logo URL blocked by SSRF guard. ${err.message}`,
            );
          }
          throw err;
        }
        // 10 s timeout. Timeout surfaces as FetchTimeoutError → caught by
        // outer wrap → re-prefixed with `brand_kit_logo_unavailable:` so
        // the cron worker refunds quota (same behaviour as a 404).
        const logoRes = await safeFetch(plan.logoUrl, {
          timeoutMs: 10_000,
          allowedHosts: defaultClipsAllowedHosts(),
        });
        if (!logoRes.ok) {
          throw new Error(
            `brand_kit_logo_unavailable: Logo fetch failed. HTTP ${logoRes.status} ${logoRes.statusText}`,
          );
        }
        const logoBuf = Buffer.from(await logoRes.arrayBuffer());
        const logoPath = join(dir, `logo-${inputIdx}.png`);
        await writeFile(logoPath, logoBuf);
        logoInputArgs.push("-i", logoPath);
        logoFilterChunks.push(plan.filterExpr(inputIdx));
        inputIdx++;
      } catch (err) {
        const msg = (err as Error).message;
        // Re-throw our own prefixed error untouched.
        if (msg.startsWith("brand_kit_logo_unavailable:")) {
          throw err;
        }
        // Network error / write failure → wrap with the same prefix so
        // the cron handler can pattern-match on a single prefix.
        throw new Error(
          `brand_kit_logo_unavailable: Logo fetch failed. ${msg.slice(0, 200)}`,
        );
      }
    }

    // Aspect ratio crop+scale prefix. When the caller specifies a target
    // ratio (9:16 / 1:1 / 4:5 / 16:9), we centre-crop the source to the
    // target ratio then scale to the canonical output dimensions. The
    // prefix runs BEFORE subtitles so libass renders into the final
    // output frame (not the cropped source dimensions).
    let aspectPrefix = "";
    if (params.aspectRatio) {
      // Canonical helper so the smart-crop X-offset logic lives in
      // exactly one place. Reads params.smartCropOffset and emits the
      // ffmpeg filter chain.
      aspectPrefix = await aspectFilterFor(
        params.aspectRatio,
        params.smartCropOffset ?? null,
      );
    }

    // Build the final -vf chain. Without overlays it's just the
    // subtitles filter ; with overlays we splice scale+fade+overlay
    // chunks between the source [0:v] tap and a final [withlogo]
    // chain that feeds into the subtitles filter.
    // (The VidiaFlow lut3d= grading stage is removed — see header.)
    const joinFilters = (...fs: string[]) => fs.filter(Boolean).join(",");
    let filterStr: string;
    if (cues.length === 0 && logoFilterChunks.length === 0) {
      filterStr = aspectPrefix || "null";
    } else if (logoFilterChunks.length === 0) {
      filterStr = joinFilters(
        aspectPrefix,
        `subtitles=${assForFilter}:fontsdir=${fontsDirForFilter}`,
      );
    } else {
      // Tap source as [main], chain logos producing [withlogo], then
      // optionally subtitles. End label is always [out] (mapped below).
      // V1 supports at most one logo per clip ; multi-logo would re-use
      // [withlogo] as base for the next chunk. Aspect prefix attaches to
      // the source tap so the logo overlay + subtitles render onto the
      // cropped+scaled frame.
      const sourceTap = aspectPrefix
        ? `[0:v]${aspectPrefix}[main]`
        : `[0:v]null[main]`;
      const subFilter =
        cues.length === 0
          ? "null"
          : `subtitles=${assForFilter}:fontsdir=${fontsDirForFilter}`;
      const tail = `;[withlogo]${subFilter}[out]`;
      filterStr = `${sourceTap};${logoFilterChunks.join(";")}${tail}`;
    }

    // ---- Audio chain ------------------------------------------------
    // `-c:a copy` semantics : audioFilter stays "anull" (no-op pass-
    // through) and the AAC re-encode is skipped entirely. Output loudness
    // varies (no -14 LUFS normalisation) — fine for short-form. Some
    // sources (mp4 with non-AAC audio) will refuse `-c:a copy` ; live
    // observed sources are AAC (and the audiogram base is AAC by
    // construction).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const audioFilter = "anull";

    // ---- Per-style CRF ------------------------------------------------
    const styleCrf = STYLE_CRF_MAP[params.styleKey] ?? 20;

    // ---- Common video flags -------------------------------------------
    // - `-g 48` keyframe every 2 s @ 24 fps : instant gallery seek.
    // - Explicit BT.709 metadata : Safari/iOS sometimes shifts saturation
    //   5-10% on H.264 yuv420p without it.
    const commonVideoFlags = [
      "-c:v",
      "libx264",
      // `ultrafast` preset cuts encode wall-clock ~10× vs `medium` for a
      // ~0.4% SSIM drop — imperceptible on talking-head short-form.
      // styleCrf's range (18-22) compensates for the lighter motion
      // search by spending the quality budget on quantization.
      "-preset",
      "ultrafast",
      "-crf",
      String(styleCrf),
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "48", // keyframe interval (2 s @ 24 fps)
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      // `+faststart` : moov atom at the start of the file for first-byte
      // HTML5 <video> seek. (The VidiaFlow streaming-mode fragmented-mp4
      // flags are removed with the streaming branch.)
      "-movflags",
      "+faststart",
    ];

    // ---- Single-pass CRF encoding -------------------------------------
    // x264 rejects `-crf` + `-pass 2` combination. Single-pass CRF : for
    // 30-180s clips the quality delta vs 2-pass with a bitrate target is
    // imperceptible (subtitles aren't size-constrained).
    const filterArgsForVideo =
      logoFilterChunks.length > 0
        ? ["-filter_complex", filterStr, "-map", "[out]"]
        : ["-vf", filterStr];

    const encodeArgs = [
      // `-autorotate 1` forces ffmpeg to apply the `displaymatrix`
      // rotation metadata BEFORE the crop / scale / subtitle filter
      // chain sees the frames. iPhone / Android portrait recordings
      // ship rotation metadata in stream side-data ; without this
      // flag the crop math operates on the wrong axis. Must land
      // BEFORE `-i` to apply to the input file.
      "-autorotate",
      "1",
      "-ss",
      params.startSec.toFixed(2),
      "-to",
      params.endSec.toFixed(2),
      "-i",
      inPath,
      ...logoInputArgs,
      ...filterArgsForVideo,
      ...(logoFilterChunks.length > 0 ? ["-map", "0:a?"] : []),
      ...commonVideoFlags,
      // `-c:a copy` skips audio re-encoding entirely when the source is
      // already AAC (common case for mp4 / mov clips + the audiogram
      // base). Saves ~10-15 s on a 50 s clip vs `-c:a aac -b:a 128k`.
      "-c:a",
      "copy",
      "-y",
      outPath,
    ];

    // Diagnostic instrumentation — capture full stderr and surface key
    // libass / subtitles-filter signals into the structured log so we can
    // tell post-hoc whether libass actually loaded the ASS and rendered
    // any subtitle frames. ffmpeg exits 0 even when the filter silently
    // produces 0 burned overlays, so exit code alone is not enough.
    const ffmpegLogger = console; // leaf module — console goes to platform logs
    const stagedDirContents = (() => {
      try {
        return readdirSync(dir).join(",");
      } catch (err) {
        return `ERR:${(err as Error).message.slice(0, 100)}`;
      }
    })();
    const interStaged = existsSync(join(dir, "Inter.ttf"));
    const firstCue = cues[0]
      ? `${cues[0].start.toFixed(2)}-${cues[0].end.toFixed(2)}:${cues[0].text.slice(0, 40)}`
      : "(none)";
    const lastCue = cues[cues.length - 1]
      ? `${cues[cues.length - 1].start.toFixed(2)}-${cues[cues.length - 1].end.toFixed(2)}`
      : "(none)";
    ffmpegLogger.log(
      `[clips-burn] start filter=${filterStr.length}c cues=${cues.length} firstCue=${firstCue} lastCue=${lastCue} clipWin=${params.startSec.toFixed(2)}-${params.endSec.toFixed(2)} dir=${dir} interStaged=${interStaged} fontFamily=${fontFamily} stagedFonts=${stagedCount} stagedDir=${stagedDirContents}`,
    );
    if (cues.length === 0) {
      ffmpegLogger.log(
        `[clips-burn] WARN no cues — Whisper returned ${params.words.length} words, preTranslatedCues=${params.preTranslatedCues?.length ?? "undef"}, output will have NO subtitles`,
      );
    }
    // Execute single-pass CRF encode. Spawn isolated so we surface ffmpeg
    // exit code + stderr tail in failure logs.
    const runFfmpeg = (passArgs: string[], passLabel: string): Promise<void> =>
      new Promise<void>((res, rej) => {
        const p = spawn(ffmpegPath.path, passArgs);
        const watchdog = attachFfmpegTimeout(p, `subtitle_${passLabel}`);
        let stderrBuf = "";
        p.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
        });
        p.on("error", (error) => {
          watchdog.clear();
          rej(error);
        });
        p.on("close", (code) => {
          watchdog.clear();
          const stderrTail = stderrBuf.slice(-1500);
          const subtitleLines = stderrBuf
            .split("\n")
            .filter(
              (l) =>
                l.includes("subtitles") ||
                l.includes("libass") ||
                l.includes("Parsed_subtitles") ||
                l.includes("fontselect") ||
                l.includes("Glyph") ||
                l.includes("ASS"),
            )
            .slice(0, 10)
            .join(" | ");
          ffmpegLogger.log(
            `[clips-burn] ${passLabel} exit=${code} signals=${JSON.stringify(subtitleLines).slice(0, 600)}`,
          );
          if (watchdog.timedOut()) {
            rej(new Error(watchdog.message()));
          } else if (code !== 0) {
            ffmpegLogger.log(
              `[clips-burn] ${passLabel} FAIL stderr=${JSON.stringify(stderrTail).slice(0, 1200)}`,
            );
            rej(
              new Error(
                `ffmpeg ${passLabel} exited ${code}: ${stderrBuf.slice(-600)}`,
              ),
            );
          } else {
            res();
          }
        });
      });

    // Build the WebVTT sidecar from the FINAL cues array (post-dedup,
    // post-cap) so the sidecar matches what the burn pipeline rendered.
    const vtt = buildVttFromCues(
      cues.map((c) => ({ text: c.text, start: c.start, end: c.end })),
    );

    // Buffer path : ffmpeg writes to /tmp at full local-disk speed, then
    // we read the buffer back for the caller to upload. (The VidiaFlow
    // streaming pattern measured 4× slower in prod — buffer-then-upload
    // is the proven shape.)
    await runFfmpeg(encodeArgs, "encode");
    const mp4 = await readFile(outPath);
    return { mp4, vtt };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
