// ============================================================================
// ClipsFlow Clips — overlay elements (motion graphics)
// ============================================================================
// API-driven overlays composited on top of the caption track. Rendered
// locally via ASS dialogue layers + ffmpeg `overlay` filter — zero external
// SaaS dependency, $0/clip.
//
// Ported from VidiaFlow src/lib/clipflow/overlays.ts (unchanged logic).
// Adaptation : CtaOutro brand color comment updated to ClipsFlow.
// ============================================================================

/**
 * Title card : big text centered, fade + scale-in entrance, optional
 * subtitle line below the main heading.
 */
export interface TitleCard {
  type: "title_card";
  /** Heading text (rendered in PrimaryColour, large) */
  text: string;
  /** Optional subtitle line below (smaller, dimmer) */
  subtitle?: string;
  /** Display window in clip-relative seconds */
  startSec: number;
  endSec: number;
  /** Optional override font (defaults to Inter Bold) */
  font?: string;
  /** Optional accent colour for heading (#RRGGBB) — defaults to white */
  color?: string;
}

/**
 * Lower-third banner : speaker name + role, slides in from left.
 */
export interface LowerThird {
  type: "lower_third";
  /** Primary line (e.g. speaker name) */
  name: string;
  /** Secondary line below (role / company) */
  role?: string;
  /** Display window in clip-relative seconds */
  startSec: number;
  endSec: number;
  /** Slide-in duration in milliseconds (default 400) */
  slideInMs?: number;
}

/**
 * Logo reveal : raster image overlay (PNG with alpha recommended).
 * Rendered via ffmpeg `overlay` filter (NOT ASS).
 */
export interface LogoReveal {
  type: "logo_reveal";
  /** HTTPS URL of the logo (PNG / JPG ; PNG with alpha preferred) */
  logoUrl: string;
  /** Corner placement on the frame (defaults to top-right) */
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Display window in clip-relative seconds (defaults to whole clip) */
  startSec?: number;
  endSec?: number;
  /** Logo height as pixels @ 1080p coords (defaults to 80) */
  heightPx?: number;
  /** Fade-in duration ms (default 500) */
  fadeInMs?: number;
}

/**
 * Stat callout : animated number popping mid-clip (e.g. "10K", "+47%", "$1M").
 */
export interface StatCallout {
  type: "stat_callout";
  /** Hero number / value, e.g. "10K", "+47%", "$1M", "100" */
  value: string;
  /** Optional caption below, e.g. "subscribers", "clicks", "saved" */
  label?: string;
  /** Display window in clip-relative seconds */
  startSec: number;
  endSec: number;
  /** Position on the frame (default top-right). */
  position?:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "center";
  /** Accent color for the value (default gold #FFD700) */
  color?: string;
}

/**
 * CTA outro : final-seconds call-to-action banner ("Subscribe ↗",
 * "Follow for more", "Like + Share").
 */
export interface CtaOutro {
  type: "cta_outro";
  /** CTA text */
  text: string;
  /** Display window — typically the LAST 1-2 seconds of the clip */
  startSec: number;
  endSec: number;
}

export type OverlayElement =
  | TitleCard
  | LowerThird
  | LogoReveal
  | StatCallout
  | CtaOutro;

// ----------------------------------------------------------------------------
// ASS dialogue builders — return Dialogue lines without the header.
// ----------------------------------------------------------------------------

/** ASS time formatter (centiseconds). Local copy so this module stays
 *  standalone — same implementation as ass-format.ts assTime. */
function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total - Math.floor(total)) * 100);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** #RRGGBB → ASS &H<BB><GG><RR>& */
function hexToAss(hex: string | undefined, fallback: string): string {
  const h = (hex ?? fallback).replace("#", "").padStart(6, "0").slice(-6);
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

/** Escape `{`, `}`, newlines for ASS dialogue text. */
function escapeAss(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

/**
 * Build an ASS Dialogue line for a TitleCard.
 */
export function buildTitleCardDialogue(
  el: TitleCard,
  defaultFont = "Inter",
): string {
  const start = assTime(el.startSec);
  const end = assTime(el.endSec);
  const color = hexToAss(el.color, "FFFFFF");
  const font = el.font ?? defaultFont;
  const main = escapeAss(el.text);
  const sub = el.subtitle ? `\\N{\\fs50}${escapeAss(el.subtitle)}` : "";
  return `Dialogue: 1,${start},${end},Default,,0,0,0,,{\\an5\\fn${font}\\b1\\fs120\\c${color}\\bord4\\shad2\\fad(300,300)\\fscx70\\fscy70\\t(0,400,\\fscx100\\fscy100)}${main}${sub}`;
}

/**
 * Build an ASS Dialogue line for a LowerThird.
 */
export function buildLowerThirdDialogue(
  el: LowerThird,
  defaultFont = "Inter",
): string {
  const start = assTime(el.startSec);
  const end = assTime(el.endSec);
  const slideMs = el.slideInMs ?? 400;
  const name = escapeAss(el.name);
  const role = el.role ? `\\N{\\fs36\\c&H00CCCCCC&}${escapeAss(el.role)}` : "";
  return `Dialogue: 2,${start},${end},Default,,0,0,0,,{\\an1\\fn${defaultFont}\\b1\\fs56\\bord3\\shad1\\move(-400,1000,80,1000,0,${slideMs})\\fad(0,300)}${name}${role}`;
}

/**
 * Build an ASS Dialogue line for a StatCallout.
 */
export function buildStatCalloutDialogue(
  el: StatCallout,
  defaultFont = "Inter",
): string {
  const start = assTime(el.startSec);
  const end = assTime(el.endSec);
  const valueColor = hexToAss(el.color, "FFD700");
  const value = escapeAss(el.value);
  const labelChunk = el.label
    ? `\\N{\\fs50\\c&HFFFFFF&\\1a&H40&}${escapeAss(el.label)}`
    : "";
  const position = el.position ?? "top-right";
  let alignTag: string;
  let posTag: string;
  switch (position) {
    case "top-left":
      alignTag = "\\an7";
      posTag = "\\pos(80,80)";
      break;
    case "bottom-right":
      alignTag = "\\an3";
      posTag = "\\pos(1840,1000)";
      break;
    case "bottom-left":
      alignTag = "\\an1";
      posTag = "\\pos(80,1000)";
      break;
    case "center":
      alignTag = "\\an5";
      posTag = "";
      break;
    case "top-right":
    default:
      alignTag = "\\an9";
      posTag = "\\pos(1840,80)";
      break;
  }
  const animation =
    "\\fad(200,200)\\fscx50\\fscy50\\frz-15" +
    "\\t(0,400,\\fscx115\\fscy115\\frz5)" +
    "\\t(400,600,\\fscx100\\fscy100\\frz0)";
  return `Dialogue: 3,${start},${end},Default,,0,0,0,,{${alignTag}${posTag}\\fn${defaultFont}\\b1\\fs140\\c${valueColor}\\bord4\\shad2${animation}}${value}${labelChunk}`;
}

/**
 * Build an ASS Dialogue line for a CtaOutro.
 */
export function buildCtaOutroDialogue(
  el: CtaOutro,
  defaultFont = "Inter",
): string {
  const start = assTime(el.startSec);
  const end = assTime(el.endSec);
  const text = escapeAss(el.text);
  // ClipsFlow accent color — cyan #22D3EE. BGR: EED322 → ASS: &HEED322&
  const ctaColor = hexToAss("#22D3EE", "22D3EE");
  const animation =
    "\\move(960,1200,960,1000,0,300)\\fad(200,300)" +
    "\\t(500,1500,\\frz3)\\t(1500,2000,\\frz-3)";
  return `Dialogue: 4,${start},${end},Default,,0,0,0,,{\\an2\\fn${defaultFont}\\b1\\fs72\\c${ctaColor}\\bord4\\shad2${animation}}${text}`;
}

// ----------------------------------------------------------------------------
// ffmpeg overlay filter for LogoReveal.
// ----------------------------------------------------------------------------

export interface LogoFilterPlan {
  /** Local filesystem path the caller must download the URL into */
  logoUrl: string;
  /** Filter expression chunk to splice into -vf chain */
  filterExpr: (logoInputIndex: number) => string;
}

/**
 * Build the ffmpeg `overlay` filter for a LogoReveal element.
 */
export function buildLogoOverlayFilter(
  el: LogoReveal,
  clipDurationSec: number,
): LogoFilterPlan {
  const position = el.position ?? "top-right";
  const heightPx = el.heightPx ?? 100;
  const fadeInSec = (el.fadeInMs ?? 500) / 1000;
  const startSec = el.startSec ?? 0;
  const endSec = el.endSec ?? clipDurationSec;
  const scaleH = `${heightPx}`;

  const margin = "main_w*0.04";
  let x: string, y: string;
  switch (position) {
    case "top-left":
      x = margin;
      y = "main_h*0.04";
      break;
    case "bottom-left":
      x = margin;
      y = "main_h-overlay_h-main_h*0.04";
      break;
    case "bottom-right":
      x = "main_w-overlay_w-main_w*0.04";
      y = "main_h-overlay_h-main_h*0.04";
      break;
    case "top-right":
    default:
      x = "main_w-overlay_w-main_w*0.04";
      y = "main_h*0.04";
      break;
  }

  // Reserved for V2 fade-in. V1 ships without logo fade.
  void fadeInSec;

  return {
    logoUrl: el.logoUrl,
    filterExpr: (idx) => {
      const sLg = `[lg${idx}]`;
      const scale = `[${idx}:v]scale=-1:${scaleH},format=rgba${sLg}`;
      const overlay = `[main]${sLg}overlay=${x}:${y}:enable='between(t\\,${startSec.toFixed(2)}\\,${endSec.toFixed(2)})'[withlogo]`;
      return `${scale};${overlay}`;
    },
  };
}

// ----------------------------------------------------------------------------
// Aggregate builder.
// ----------------------------------------------------------------------------

export interface OverlayBuildResult {
  /** ASS Dialogue lines to append to the captions ASS body */
  assDialogues: string[];
  /** Logo elements requiring `-i <path>` + filter chain wiring */
  logoPlans: LogoFilterPlan[];
}

export function buildOverlays(
  overlays: OverlayElement[] | undefined,
  clipDurationSec: number,
  defaultFont = "Inter",
): OverlayBuildResult {
  const result: OverlayBuildResult = { assDialogues: [], logoPlans: [] };
  if (!overlays || overlays.length === 0) return result;

  for (const el of overlays) {
    switch (el.type) {
      case "title_card":
        result.assDialogues.push(buildTitleCardDialogue(el, defaultFont));
        break;
      case "lower_third":
        result.assDialogues.push(buildLowerThirdDialogue(el, defaultFont));
        break;
      case "logo_reveal":
        result.logoPlans.push(buildLogoOverlayFilter(el, clipDurationSec));
        break;
      case "stat_callout":
        result.assDialogues.push(buildStatCalloutDialogue(el, defaultFont));
        break;
      case "cta_outro":
        result.assDialogues.push(buildCtaOutroDialogue(el, defaultFont));
        break;
    }
  }
  return result;
}
