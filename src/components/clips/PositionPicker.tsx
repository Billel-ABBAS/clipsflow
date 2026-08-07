"use client";

// ============================================================================
// PositionPicker — visual 5-corner (or 4-corner) picker for overlay
// positions. Ported from VidiaFlow src/components/clipflow/PositionPicker.tsx
// (unchanged logic). Adaptations : i18n namespace
// dashboard.clipflow.position_picker → clips.position_picker.
// ============================================================================

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export type CornerPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

export interface PositionPickerProps {
  value: CornerPosition;
  onChange: (next: CornerPosition) => void;
  /** Show the center option (stat_callout only). Defaults to true. */
  allowCenter?: boolean;
  /** Label rendered above the visualizer */
  label?: string;
  /** Sample text shown inside the dot — defaults to "•" */
  dotLabel?: string;
}

/**
 * Renders a 16:9 mini frame mockup that mirrors the actual clip frame.
 * Each position option is a 24-px tap target (WCAG 2.5.8 AA minimum).
 */
export function PositionPicker({
  value,
  onChange,
  allowCenter = true,
  label,
  dotLabel = "•",
}: PositionPickerProps) {
  const t = useTranslations("clips.position_picker");
  const positions: CornerPosition[] = allowCenter
    ? ["top-left", "top-right", "bottom-left", "bottom-right", "center"]
    : ["top-left", "top-right", "bottom-left", "bottom-right"];

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <span className="text-muted-foreground text-xs font-medium">
          {label}
        </span>
      )}
      {/* 16:9 frame mockup with 4 corner dots + optional center dot */}
      <div className="border-border relative aspect-video w-32 rounded-md border bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-950">
        {positions.map((pos) => {
          const isSelected = value === pos;
          const cornerClass = {
            "top-left": "top-0 left-0",
            "top-right": "top-0 right-0",
            "bottom-left": "bottom-0 left-0",
            "bottom-right": "bottom-0 right-0",
            center: "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
          }[pos];
          return (
            <button
              key={pos}
              type="button"
              onClick={() => onChange(pos)}
              aria-label={t(
                pos.replace(/-/g, "_") as
                  | "top_left"
                  | "top_right"
                  | "bottom_left"
                  | "bottom_right"
                  | "center",
              )}
              aria-pressed={isSelected}
              className={cn(
                "focus-visible:ring-ring absolute flex h-6 w-6 items-center justify-center rounded-full text-[8px] font-bold transition-all focus-visible:ring-2 focus-visible:outline-none",
                cornerClass,
                isSelected
                  ? "bg-primary text-primary-foreground ring-ring/50 scale-110 ring-2"
                  : "bg-white/30 text-white/70 hover:scale-110 hover:bg-white/60",
              )}
            >
              {isSelected ? dotLabel : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}
