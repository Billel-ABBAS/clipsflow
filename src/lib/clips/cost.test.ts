// ============================================================================
// Tests unitaires — cost.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import { computeClipCost } from "./cost";

// Constantes importées (reflétées ici pour les assertions numériques)
const WHISPER_PER_SEC = 0.0000111;
const IO_FIXED = 0.000525 + 0.00225; // storage + bandwidth
const COMPUTE_PER_SEC = 0.000005;

describe("computeClipCost", () => {
  it("retourne 0 pour une durée ≤ 0", () => {
    expect(computeClipCost(0)).toBe(0);
    expect(computeClipCost(-10)).toBe(0);
  });

  it("retourne 0 pour NaN", () => {
    expect(computeClipCost(NaN)).toBe(0);
  });

  it("retourne 0 pour Infinity", () => {
    expect(computeClipCost(Infinity)).toBe(0);
  });

  it("retourne 0 pour -Infinity", () => {
    expect(computeClipCost(-Infinity)).toBe(0);
  });

  it("valeur connue pour 60 secondes", () => {
    const expected =
      Math.round(
        (WHISPER_PER_SEC * 60 + IO_FIXED + COMPUTE_PER_SEC * 60) * 1e6,
      ) / 1e6;
    expect(computeClipCost(60)).toBeCloseTo(expected, 6);
  });

  it("valeur connue pour 30 secondes", () => {
    const expected =
      Math.round(
        (WHISPER_PER_SEC * 30 + IO_FIXED + COMPUTE_PER_SEC * 30) * 1e6,
      ) / 1e6;
    expect(computeClipCost(30)).toBeCloseTo(expected, 6);
  });

  it("le coût est strictement croissant avec la durée", () => {
    const c30 = computeClipCost(30);
    const c60 = computeClipCost(60);
    const c120 = computeClipCost(120);
    const c180 = computeClipCost(180);
    expect(c60).toBeGreaterThan(c30);
    expect(c120).toBeGreaterThan(c60);
    expect(c180).toBeGreaterThan(c120);
  });

  it("le coût pour 1 seconde est positif", () => {
    expect(computeClipCost(1)).toBeGreaterThan(0);
  });

  it("le résultat a au plus 6 décimales de précision", () => {
    const cost = computeClipCost(45);
    const asStr = cost.toString();
    const decimals = asStr.includes(".") ? asStr.split(".")[1]!.length : 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });

  it("le coût pour 1800 s (plafond pro/mois) est raisonnable (< 0.1$)", () => {
    // Vérification de cohérence métier : 30 min de clip ne doit pas coûter > 0.10$
    expect(computeClipCost(1800)).toBeLessThan(0.1);
  });

  it("la composante I/O fixe est incluse même pour 1 seconde", () => {
    // Pour 1s, le coût doit être > IO_FIXED seul (il y a aussi du compute)
    const cost1s = computeClipCost(1);
    expect(cost1s).toBeGreaterThan(IO_FIXED);
  });
});
