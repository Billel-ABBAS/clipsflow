"use client";

import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";

import {
  isPresetAllowedForPlan,
  PRESET_CARDS,
  type PresetBundle,
  type PresetCode,
} from "@/lib/clips/preset-defaults";
import type { Plan } from "@/lib/clips/quota";
import { cn } from "@/lib/utils";

// ============================================================================
// PresetGrid — 12 preset cards + compact banner once a preset is active.
// Ported from VidiaFlow src/components/clipflow/PresetGrid.tsx.
// Adaptations : i18n namespace dashboard.clipflow → clips ; the `plan` prop
// is the ClipsFlow quota Plan (free/solo/pro/studio) and is mapped to the
// preset-defaults tier ladder (solo ↔ creator) before gating ; selection
// tokens accent → primary.
// ============================================================================

export interface PresetGridProps {
  /** Currently-active preset (null = no preset selected, grid visible). */
  selectedCode: PresetCode | null;
  /** User's plan — used to disable cards that require a higher tier. */
  plan: Plan;
  /** Callback when the user clicks a preset card. The parent (ClipStudio)
   *  hydrates form state from `preset.defaults`. */
  onSelect: (preset: PresetBundle) => void;
  /** Callback to reset back to the grid (clears selection). */
  onReset: () => void;
}

export function PresetGrid({
  selectedCode,
  plan,
  onSelect,
  onReset,
}: PresetGridProps) {
  const t = useTranslations("clips");

  // preset-defaults.ts gates on the VidiaFlow tier ladder
  // (free/creator/pro/studio/agency). ClipsFlow's 'solo' maps to 'creator'
  // (same position on the ladder) ; the other names line up 1:1.
  const presetPlan = plan === "solo" ? ("creator" as const) : plan;

  // Once a preset is selected the grid collapses into a compact banner
  // with a "Change" link — keeps the form short while staying 1-click
  // reversible.
  if (selectedCode) {
    const active = PRESET_CARDS.find((p) => p.code === selectedCode);
    if (!active) return null;
    return (
      <div className="border-border bg-card flex items-center justify-between rounded-xl border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-xl" aria-hidden="true">
            {active.icon}
          </span>
          <div>
            <p className="text-foreground text-sm font-semibold">
              {t(active.nameKey)}
            </p>
            <p className="text-muted-foreground text-xs">
              {t(active.taglineKey)}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="text-primary focus:ring-ring rounded text-xs font-medium hover:underline focus:ring-2 focus:outline-none"
        >
          {t("presets.change")}
        </button>
      </div>
    );
  }

  return (
    <section>
      <header className="mb-4">
        <h3 className="text-foreground text-lg font-semibold">
          {t("presets.section_title")}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t("presets.section_subtitle")}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PRESET_CARDS.map((preset) => {
          const allowed = isPresetAllowedForPlan(preset, presetPlan);
          return (
            <button
              key={preset.code}
              type="button"
              onClick={() => allowed && onSelect(preset)}
              disabled={!allowed}
              aria-disabled={!allowed}
              aria-label={
                allowed
                  ? t(preset.nameKey)
                  : `${t(preset.nameKey)} — ${t("presets.locked", {
                      plan: preset.requiredPlan,
                    })}`
              }
              className={cn(
                "group bg-card focus:ring-ring relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition focus:ring-2 focus:outline-none",
                allowed
                  ? "border-border hover:border-primary hover:bg-card/80 cursor-pointer"
                  : "border-border/50 cursor-not-allowed opacity-50",
              )}
            >
              <span className="text-2xl" aria-hidden="true">
                {preset.icon}
              </span>
              <span className="text-foreground font-semibold">
                {t(preset.nameKey)}
              </span>
              <span className="text-muted-foreground line-clamp-2 text-xs">
                {t(preset.taglineKey)}
              </span>
              {!allowed && (
                <span
                  className="bg-muted text-muted-foreground absolute top-3 right-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                  title={t("presets.locked", { plan: preset.requiredPlan })}
                >
                  <Lock className="h-2.5 w-2.5" />
                  {preset.requiredPlan}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
