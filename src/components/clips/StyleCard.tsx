"use client";

import { useState } from "react";
import { Lock } from "lucide-react";

import { SIGNATURE_STYLES } from "@/lib/clips/subtitle-styles";
import type { StyleKey } from "@/lib/clips/types";
import { cn } from "@/lib/utils";

// ============================================================================
// StyleCard — one card per signature subtitle style (15 total).
// Ported from VidiaFlow src/components/clipflow/StyleCard.tsx (unchanged
// logic). Adaptations : imports → @/lib/clips/* ; selection tokens accent →
// primary (neutral shadcn theme).
// ============================================================================

export interface StyleCardProps {
  styleKey: StyleKey;
  selected: boolean;
  enabled: boolean;
  onSelect: () => void;
  /** i18n label for the locked badge — supplied by parent to avoid double t() call */
  proLockedLabel?: string;
}

/**
 * Per-preset visual preview spec used to render an in-card mini-mockup
 * (no GIF needed). Mirrors the actual ASS rendering parameters in
 * `subtitle-burn.ts` so the user sees a faithful thumbnail of what each
 * preset will produce.
 */
const PREVIEW_SPECS: Record<
  StyleKey,
  {
    sample: string;
    fontFamily: string;
    primaryColor: string;
    accentColor: string;
    textTransform: "uppercase" | "lowercase" | "none";
    fontWeight: 400 | 600 | 800 | 900;
    letterSpacing: string;
    textShadow: string;
    fontSizeRem: number;
  }
> = {
  viral: {
    sample: "VIRAL",
    fontFamily: '"Inter", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFD700",
    textTransform: "uppercase",
    fontWeight: 900,
    letterSpacing: "0.02em",
    textShadow:
      "0 0 0 #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000",
    fontSizeRem: 1.6,
  },
  premium: {
    sample: "Premium content",
    fontFamily: '"Plus Jakarta Sans", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFFFFF",
    textTransform: "none",
    fontWeight: 600,
    letterSpacing: "0",
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
    fontSizeRem: 0.95,
  },
  hormozi: {
    sample: "HORMOZI",
    fontFamily: '"Bebas Neue", "Anton", sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFD700",
    textTransform: "uppercase",
    fontWeight: 400,
    letterSpacing: "0.04em",
    textShadow:
      "0 0 0 #FFD700, 2px 2px 0 #FFD700, -2px -2px 0 #FFD700, 2px -2px 0 #FFD700, -2px 2px 0 #FFD700",
    fontSizeRem: 1.8,
  },
  mrbeast: {
    sample: "MRBEAST",
    fontFamily: '"Montserrat", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#34C759",
    textTransform: "uppercase",
    fontWeight: 900,
    letterSpacing: "0.01em",
    textShadow:
      "0 0 0 #000, 3px 3px 0 #000, -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000",
    fontSizeRem: 1.5,
  },
  iman: {
    sample: "iman style",
    fontFamily: '"Plus Jakarta Sans", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFFFFF",
    textTransform: "lowercase",
    fontWeight: 600,
    letterSpacing: "0",
    textShadow: "0 1px 2px rgba(0,0,0,0.4)",
    fontSizeRem: 1.05,
  },
  minimal: {
    sample: "minimal",
    fontFamily: '"Inter", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFFFFF",
    textTransform: "none",
    fontWeight: 400,
    letterSpacing: "0",
    textShadow: "0 1px 1px rgba(0,0,0,0.3)",
    fontSizeRem: 0.9,
  },
  // Neon : cyan text with magenta double-blur glow approximation.
  neon: {
    sample: "NEON GLOW",
    fontFamily: '"Inter", system-ui, sans-serif',
    primaryColor: "#00FFFF",
    accentColor: "#FF00FF",
    textTransform: "uppercase",
    fontWeight: 800,
    letterSpacing: "0.04em",
    textShadow: "0 0 10px #FF00FF, 0 0 20px #FF00FF",
    fontSizeRem: 1.4,
  },
  // Typewriter : monospace stack hints at terminal feel. The trailing
  // underscore doubles as a static "cursor" glyph.
  typewriter: {
    sample: "TYPING_",
    fontFamily: '"Courier New", "Courier", monospace',
    primaryColor: "#FFFFFF",
    accentColor: "#FFFFFF",
    textTransform: "uppercase",
    fontWeight: 600,
    letterSpacing: "0.06em",
    textShadow: "0 1px 1px rgba(0,0,0,0.4)",
    fontSizeRem: 1.2,
  },
  // Bounce : Montserrat Black UPPERCASE, gold accent for second word.
  bounce: {
    sample: "BOUNCE NOW",
    fontFamily: '"Montserrat", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFD700",
    textTransform: "uppercase",
    fontWeight: 900,
    letterSpacing: "0.01em",
    textShadow:
      "0 0 0 #000, 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000",
    fontSizeRem: 1.45,
  },
  // Bar : opaque box behind the text (BorderStyle=4 render).
  bar: {
    sample: "Subtitle bar",
    fontFamily: '"Inter", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFFFFF",
    textTransform: "none",
    fontWeight: 600,
    letterSpacing: "0",
    textShadow: "none",
    fontSizeRem: 1.0,
  },
  // Cinematic : serif italic feel via Georgia / Times stack.
  cinematic: {
    sample: "Cinematic story",
    fontFamily: '"Georgia", "Times New Roman", serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFFFFF",
    textTransform: "none",
    fontWeight: 400,
    letterSpacing: "0",
    textShadow: "0 1px 2px rgba(0,0,0,0.5)",
    fontSizeRem: 1.0,
  },
  // Karaoke Pop : white base + yellow flash on the 2nd word stands in
  // for per-word colour cycling on the real ASS render.
  karaoke_pop: {
    sample: "POP WORD",
    fontFamily: '"Inter", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FFE600",
    textTransform: "uppercase",
    fontWeight: 900,
    letterSpacing: "0.03em",
    textShadow:
      "0 0 0 #000, 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000",
    fontSizeRem: 1.5,
  },
  // Halo Glow : warm-white outer glow via double-blurred amber shadow.
  halo_glow: {
    sample: "Halo glow",
    fontFamily: '"Plus Jakarta Sans", system-ui, sans-serif',
    primaryColor: "#F8F4E8",
    accentColor: "#FFC88C",
    textTransform: "none",
    fontWeight: 600,
    letterSpacing: "0.01em",
    textShadow:
      "0 0 18px rgba(255,200,140,0.65), 0 0 36px rgba(255,200,140,0.35)",
    fontSizeRem: 1.15,
  },
  // Trailer Inferno : white base + red-orange accent + hard drop shadow.
  trailer_inferno: {
    sample: "TRAILER INFERNO",
    fontFamily: '"Bebas Neue", "Anton", sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FF3B00",
    textTransform: "uppercase",
    fontWeight: 400,
    letterSpacing: "0.02em",
    textShadow:
      "0 4px 0 #1A0500, 2px 2px 0 #8B1A00, -2px -2px 0 #8B1A00, 2px -2px 0 #8B1A00, -2px 2px 0 #8B1A00",
    fontSizeRem: 1.55,
  },
  // Comic Bubble : opaque pill rendered via wrapper background (special-
  // cased like `bar` below).
  comic_bubble: {
    sample: "Comic bubble",
    fontFamily: '"Poppins", system-ui, sans-serif',
    primaryColor: "#FFFFFF",
    accentColor: "#FF2D55",
    textTransform: "none",
    fontWeight: 800,
    letterSpacing: "0",
    textShadow: "none",
    fontSizeRem: 1.0,
  },
};

export function StyleCard({
  styleKey,
  selected,
  enabled,
  onSelect,
  proLockedLabel,
}: StyleCardProps) {
  const style = SIGNATURE_STYLES[styleKey];
  const spec = PREVIEW_SPECS[styleKey];

  // Animated GIF preview state. Default = CSS mockup visible. Once the GIF
  // finishes downloading it fades in over the mockup ; on 404 / error the
  // mockup stays permanently visible (P1 ships no GIF assets — the CSS
  // mockup IS the preview).
  const [gifLoaded, setGifLoaded] = useState(false);
  const [gifError, setGifError] = useState(false);
  // Respect prefers-reduced-motion : motion-sensitive users keep the
  // static CSS mockup.
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const showGif =
    gifLoaded && !gifError && !!style.preview_gif_url && !prefersReducedMotion;

  return (
    <button
      type="button"
      onClick={enabled ? onSelect : undefined}
      disabled={!enabled}
      aria-pressed={selected}
      className={cn(
        "focus-visible:ring-ring relative flex flex-col gap-2 rounded-xl border p-1 text-left transition-all focus-visible:ring-2 focus-visible:outline-none",
        selected
          ? "border-primary bg-primary/10 ring-primary ring-1"
          : "border-border bg-card hover:border-primary/50",
        !enabled && "cursor-not-allowed opacity-60",
      )}
    >
      {/* Preview area : in-browser mockup matching the ASS render specs. */}
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-950">
        {style.preview_gif_url && !gifError && !prefersReducedMotion && (
          // next/image collapses animated GIFs to a single optimized frame
          // on its default loader path — raw <img> preserves the loop.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={style.preview_gif_url}
            alt={`${style.display_name} preview`}
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition-opacity",
              showGif ? "opacity-100" : "opacity-0",
            )}
            onLoad={() => setGifLoaded(true)}
            onError={() => setGifError(true)}
            loading="lazy"
            decoding="async"
          />
        )}
        <div
          className={cn(
            "absolute inset-0 flex items-end justify-center pb-3 transition-opacity",
            showGif ? "pointer-events-none opacity-0" : "opacity-100",
          )}
        >
          <span
            style={{
              color: spec.primaryColor,
              fontFamily: spec.fontFamily,
              fontWeight: spec.fontWeight,
              letterSpacing: spec.letterSpacing,
              textTransform: spec.textTransform,
              textShadow: spec.textShadow,
              fontSize: `${spec.fontSizeRem}rem`,
              lineHeight: 1.05,
              textAlign: "center",
              padding: "0 0.5rem",
              fontStyle: styleKey === "cinematic" ? "italic" : "normal",
              // `bar` : opaque box behind the text (ASS BorderStyle=4).
              // `comic_bubble` : opaque pill (BorderStyle=3).
              ...(styleKey === "bar"
                ? {
                    background: "#000000",
                    padding: "2px 6px",
                    borderRadius: "2px",
                  }
                : styleKey === "comic_bubble"
                  ? {
                      background: "#000000",
                      padding: "4px 14px",
                      borderRadius: "20px",
                    }
                  : {}),
            }}
            className="block max-w-full truncate"
          >
            {/* Second word renders in accentColor so the karaoke-highlight
                visual is hinted at. Single-word samples swap the whole
                word to accent when accent != primary. */}
            {(() => {
              const parts = spec.sample.split(" ");
              if (parts.length === 1) {
                return spec.accentColor !== spec.primaryColor ? (
                  <span style={{ color: spec.accentColor }}>{parts[0]}</span>
                ) : (
                  parts[0]
                );
              }
              return (
                <>
                  {parts[0]}{" "}
                  <span style={{ color: spec.accentColor }}>
                    {parts.slice(1).join(" ")}
                  </span>
                </>
              );
            })()}
          </span>
        </div>

        {/* Lock badge */}
        {!enabled && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
            <span className="flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white">
              <Lock className="h-3 w-3" />
              {proLockedLabel ?? "Pro"}
            </span>
          </div>
        )}

        {/* Selected checkmark */}
        {selected && enabled && (
          <div className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full">
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                d="M2 6l3 3 5-5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Label + description */}
      <div className="px-1 pb-1">
        <p className="text-foreground text-sm font-semibold">
          {style.display_name}
        </p>
        <p className="text-muted-foreground line-clamp-2 text-xs">
          {style.display_description}
        </p>
      </div>
    </button>
  );
}
