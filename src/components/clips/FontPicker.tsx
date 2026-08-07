"use client";

import { CURATED_FONTS, type CuratedFont } from "@/lib/clips/subtitle-styles";
import { cn } from "@/lib/utils";

// ============================================================================
// FontPicker — curated font grid (studio plan).
// Ported from VidiaFlow src/components/clipflow/FontPicker.tsx.
// Adaptations : brand-kit branch removed entirely (customFont / tier /
// onUploadCustom / mode props dropped — ClipsFlow has no agency tier and no
// brand kits in P1) ; import path → @/lib/clips/subtitle-styles ; selection
// tokens accent → primary.
// ============================================================================

export interface FontPickerProps {
  value: string;
  onChange: (font: string) => void;
  disabled?: boolean;
}

export function FontPicker({ value, onChange, disabled }: FontPickerProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <div className="flex flex-wrap gap-2">
        {CURATED_FONTS.map((font: CuratedFont) => (
          <button
            key={font}
            type="button"
            onClick={() => onChange(font)}
            aria-pressed={value === font}
            style={{ fontFamily: font }}
            className={cn(
              "focus-visible:ring-ring rounded-lg border px-3 py-1.5 text-sm transition-all focus-visible:ring-2 focus-visible:outline-none",
              value === font
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-foreground hover:border-primary/50",
            )}
          >
            Aa — {font}
          </button>
        ))}
      </div>
    </div>
  );
}
