"use client";

import { useCallback, useId, useState } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { PRO_COLOR_PALETTE } from "@/lib/clips/subtitle-styles";
import { cn } from "@/lib/utils";

// ============================================================================
// ColorPicker — tier-aware swatch + native picker.
// Ported from VidiaFlow src/components/clipflow/ColorPicker.tsx.
// Adaptations : import path subtitle-styles → @/lib/clips/subtitle-styles ;
// i18n namespace dashboard.clipflow → clips ; selection tokens accent →
// primary (neutral shadcn theme).
//
//   - mode="palette" : pro plan — 8 curated swatches only.
//   - mode="free"    : studio plan — swatches + native picker + hex input.
// ============================================================================

export interface ColorPickerProps {
  mode: "palette" | "free";
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

function isValidHex(v: string): boolean {
  return HEX_RE.test(v);
}

export function ColorPicker({
  mode,
  value,
  onChange,
  disabled,
}: ColorPickerProps) {
  const t = useTranslations("clips");
  const [hexInput, setHexInput] = useState(value ?? "#FFFFFF");
  // useId — the customization panel renders ColorPicker twice (text +
  // highlight). A static id would collide and break label → input focus.
  const nativeId = useId();
  const nativeFieldId = `clips-color-native-${nativeId}`;

  const handleHexInputChange = useCallback(
    (raw: string) => {
      const normalised = raw.startsWith("#") ? raw : `#${raw}`;
      setHexInput(normalised);
      if (isValidHex(normalised)) onChange(normalised);
    },
    [onChange],
  );

  const handleNativeColorChange = useCallback(
    (hex: string) => {
      setHexInput(hex);
      onChange(hex);
    },
    [onChange],
  );

  const handleSwatchClick = useCallback(
    (hex: string) => {
      setHexInput(hex);
      onChange(hex);
    },
    [onChange],
  );

  // Swatch grid — shared between palette + free modes. Source of truth :
  // PRO_COLOR_PALETTE (8 colours) so the visual stays consistent across
  // tiers ; studio just gets the extra free-hex affordances on top.
  const swatchGrid = (
    <div
      className="flex flex-wrap gap-2"
      aria-label={t("color_palette_aria")}
      role="group"
    >
      {PRO_COLOR_PALETTE.map((color) => {
        const selected = value?.toLowerCase() === color.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            onClick={() => handleSwatchClick(color)}
            aria-label={t("color_picker.selected_aria", { hex: color })}
            aria-pressed={selected}
            style={{ background: color }}
            className={cn(
              "focus-visible:ring-ring h-8 w-8 rounded-md border-2 transition-all focus-visible:ring-2 focus-visible:outline-none",
              selected
                ? "border-primary ring-primary scale-110 ring-2"
                : "border-border/50 hover:scale-110",
            )}
          />
        );
      })}
    </div>
  );

  if (mode === "palette") {
    return (
      <div
        className={cn(
          "space-y-2",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        {swatchGrid}
      </div>
    );
  }

  // free mode — studio. Swatches AND native picker AND hex input. The
  // native picker covers visual exploration ; the hex input lets brand
  // teams paste their exact colour token.
  return (
    <div
      className={cn("space-y-3", disabled && "pointer-events-none opacity-50")}
    >
      {swatchGrid}
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={nativeFieldId}>
          {t("color_free_label")}
        </label>
        <input
          id={nativeFieldId}
          type="color"
          value={isValidHex(hexInput) ? hexInput : "#FFFFFF"}
          onChange={(e) => handleNativeColorChange(e.target.value)}
          className="border-border h-8 w-8 cursor-pointer rounded-md border bg-transparent p-0.5"
        />
        <Input
          aria-label={t("color_hex_aria")}
          value={hexInput}
          onChange={(e) => handleHexInputChange(e.target.value)}
          maxLength={7}
          className="w-28 font-mono text-sm"
          placeholder={t("color_hex_placeholder")}
        />
        <span className="text-muted-foreground text-xs">
          {t("color_picker.studio_custom_hint")}
        </span>
      </div>
    </div>
  );
}
