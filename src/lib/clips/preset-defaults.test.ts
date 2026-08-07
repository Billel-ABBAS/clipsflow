// ============================================================================
// Tests unitaires — preset-defaults.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  PRESET_CARDS,
  findPreset,
  isPresetAllowedForPlan,
} from "./preset-defaults";
import { STYLE_KEYS, ASPECT_RATIOS } from "./types";

const VALID_PLANS = ["free", "creator", "pro", "studio", "agency"] as const;

// ---------------------------------------------------------------------------
// Intégrité structurelle des 12 presets
// ---------------------------------------------------------------------------
describe("PRESET_CARDS — structure", () => {
  it("contient exactement 12 presets", () => {
    expect(PRESET_CARDS).toHaveLength(12);
  });

  it("chaque preset a un code unique", () => {
    const codes = PRESET_CARDS.map((p) => p.code);
    expect(new Set(codes).size).toBe(12);
  });

  it("chaque preset a un icon non vide", () => {
    for (const p of PRESET_CARDS) {
      expect(p.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it("chaque preset a un nameKey non vide", () => {
    for (const p of PRESET_CARDS) {
      expect(p.nameKey.trim().length).toBeGreaterThan(0);
    }
  });

  it("chaque preset a un taglineKey non vide", () => {
    for (const p of PRESET_CARDS) {
      expect(p.taglineKey.trim().length).toBeGreaterThan(0);
    }
  });

  it("chaque preset a un requiredPlan valide", () => {
    for (const p of PRESET_CARDS) {
      expect(VALID_PLANS).toContain(p.requiredPlan as string);
    }
  });

  it("les nameKey suivent le pattern 'presets.<code>.name'", () => {
    for (const p of PRESET_CARDS) {
      expect(p.nameKey).toBe(`presets.${p.code}.name`);
    }
  });

  it("les taglineKey suivent le pattern 'presets.<code>.tagline'", () => {
    for (const p of PRESET_CARDS) {
      expect(p.taglineKey).toBe(`presets.${p.code}.tagline`);
    }
  });
});

// ---------------------------------------------------------------------------
// Valeurs de defaults
// ---------------------------------------------------------------------------
describe("PRESET_CARDS — defaults", () => {
  it("styleKey présent → appartient à STYLE_KEYS", () => {
    for (const p of PRESET_CARDS) {
      if (p.defaults.styleKey !== undefined) {
        expect(STYLE_KEYS as readonly string[]).toContain(p.defaults.styleKey);
      }
    }
  });

  it("aspectRatio présent → appartient à ASPECT_RATIOS", () => {
    for (const p of PRESET_CARDS) {
      if (p.defaults.aspectRatio !== undefined) {
        expect(ASPECT_RATIOS as readonly string[]).toContain(
          p.defaults.aspectRatio,
        );
      }
    }
  });

  it("segmentEndTs présent → format mm:ss valide", () => {
    const TS_RE = /^\d{2}:\d{2}$/;
    for (const p of PRESET_CARDS) {
      if (p.defaults.segmentEndTs !== undefined) {
        expect(p.defaults.segmentEndTs).toMatch(TS_RE);
      }
    }
  });

  it("le preset 'custom' a des defaults vides", () => {
    const custom = PRESET_CARDS.find((p) => p.code === "custom")!;
    expect(Object.keys(custom.defaults)).toHaveLength(0);
  });

  it("le preset 'viral_tiktok' cible le format 9:16", () => {
    const viral = PRESET_CARDS.find((p) => p.code === "viral_tiktok")!;
    expect(viral.defaults.aspectRatio).toBe("9:16");
  });

  it("le preset 'youtube_tutorial' cible le format 16:9", () => {
    const yt = PRESET_CARDS.find((p) => p.code === "youtube_tutorial")!;
    expect(yt.defaults.aspectRatio).toBe("16:9");
  });

  it("les presets hormozi/mrbeast/sports_highlight ont overlayCounter=true", () => {
    const withCounter = PRESET_CARDS.filter(
      (p) => p.defaults.overlayCounter === true,
    );
    const codes = withCounter.map((p) => p.code);
    expect(codes).toContain("hormozi_style");
    expect(codes).toContain("mrbeast_energy");
    expect(codes).toContain("sports_highlight");
  });
});

// ---------------------------------------------------------------------------
// findPreset
// ---------------------------------------------------------------------------
describe("findPreset", () => {
  it("retrouve un preset par code", () => {
    const p = findPreset("viral_tiktok");
    expect(p.code).toBe("viral_tiktok");
  });

  it("retrouve le preset 'custom'", () => {
    const p = findPreset("custom");
    expect(p.code).toBe("custom");
  });

  it("throw sur un code inconnu", () => {
    expect(() => findPreset("unknown_code" as never)).toThrow(
      /unknown preset code/,
    );
  });
});

// ---------------------------------------------------------------------------
// isPresetAllowedForPlan — gating
// ---------------------------------------------------------------------------
describe("isPresetAllowedForPlan", () => {
  it("free peut utiliser les presets free", () => {
    const viral = findPreset("viral_tiktok"); // requiredPlan: free
    expect(isPresetAllowedForPlan(viral, "free")).toBe(true);
  });

  it("free ne peut pas utiliser les presets creator", () => {
    const linkedin = findPreset("linkedin_pro"); // requiredPlan: creator
    expect(isPresetAllowedForPlan(linkedin, "free")).toBe(false);
  });

  it("creator peut utiliser les presets creator", () => {
    const linkedin = findPreset("linkedin_pro");
    expect(isPresetAllowedForPlan(linkedin, "creator")).toBe(true);
  });

  it("creator ne peut pas utiliser les presets pro", () => {
    const hormozi = findPreset("hormozi_style"); // requiredPlan: pro
    expect(isPresetAllowedForPlan(hormozi, "creator")).toBe(false);
  });

  it("pro peut utiliser les presets pro", () => {
    const hormozi = findPreset("hormozi_style");
    expect(isPresetAllowedForPlan(hormozi, "pro")).toBe(true);
  });

  it("studio peut utiliser tous les presets (plan le plus haut)", () => {
    for (const p of PRESET_CARDS) {
      expect(isPresetAllowedForPlan(p, "studio")).toBe(true);
    }
  });

  it("agency peut utiliser tous les presets", () => {
    for (const p of PRESET_CARDS) {
      expect(isPresetAllowedForPlan(p, "agency")).toBe(true);
    }
  });
});
