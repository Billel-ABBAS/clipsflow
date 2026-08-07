// ============================================================================
// Tests unitaires — srt-formatter.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import { toSrt, toVtt } from "./srt-formatter";
import type { TranscriptSegment } from "./srt-formatter";

// Segments de test
const SEG_A: TranscriptSegment = {
  start: 0,
  duration: 2.5,
  text: "Hello world",
};
const SEG_B: TranscriptSegment = {
  start: 2.5,
  duration: 3,
  text: "This is a test",
};
const SEG_C: TranscriptSegment = {
  start: 3661.5,
  duration: 1.234,
  text: "Hour mark",
};

// ---------------------------------------------------------------------------
// toSrt
// ---------------------------------------------------------------------------
describe("toSrt", () => {
  it("retourne une chaîne vide pour un tableau vide", () => {
    expect(toSrt([])).toBe("");
  });

  it("génère le bon format SRT pour 1 segment", () => {
    const result = toSrt([SEG_A]);
    // Séquence 1 + timestamps avec virgule + texte + ligne vide
    expect(result).toContain("1\n");
    expect(result).toContain("00:00:00,000 --> 00:00:02,500\n");
    expect(result).toContain("Hello world\n");
  });

  it("les séquences commencent à 1 et incrémentent", () => {
    const result = toSrt([SEG_A, SEG_B]);
    // Le premier segment commence en début de chaîne "1\n..."
    expect(result).toMatch(/^1\n/);
    // Le second segment a "2\n" qui suit une ligne vide (séparateur SRT)
    expect(result).toContain("\n2\n");
  });

  it("les segments sont séparés par une ligne vide", () => {
    const result = toSrt([SEG_A, SEG_B]);
    // Chaque entrée SRT se termine par \n, et join("\\n") ajoute une ligne vide entre eux
    expect(result).toContain("\n\n");
  });

  it("calcule correctement la fin (start + duration)", () => {
    // SEG_B : start=2.5, duration=3 → end=5.5
    const result = toSrt([SEG_B]);
    expect(result).toContain("00:00:02,500 --> 00:00:05,500\n");
  });

  it("formate correctement un timestamp > 1 heure", () => {
    const result = toSrt([SEG_C]);
    // start=3661.5 → 01:01:01,500; end=3662.734 → 01:01:02,734
    expect(result).toContain("01:01:01,500 --> 01:01:02,734\n");
    expect(result).toContain("Hour mark\n");
  });

  it("le format SRT utilise une virgule (pas un point) comme séparateur ms", () => {
    const result = toSrt([SEG_A]);
    // Doit contenir des virgules dans les timestamps
    expect(result).toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
    // Ne doit PAS contenir de point dans les timestamps
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
  });
});

// ---------------------------------------------------------------------------
// toVtt
// ---------------------------------------------------------------------------
describe("toVtt", () => {
  it("commence toujours par 'WEBVTT'", () => {
    expect(toVtt([])).toMatch(/^WEBVTT/);
    expect(toVtt([SEG_A])).toMatch(/^WEBVTT/);
  });

  it("retourne juste l'en-tête pour un tableau vide", () => {
    const result = toVtt([]);
    expect(result).toBe("WEBVTT\n\n");
  });

  it("génère le bon format VTT pour 1 segment", () => {
    const result = toVtt([SEG_A]);
    // Timestamps VTT avec point (pas virgule)
    expect(result).toContain("00:00:00.000 --> 00:00:02.500\n");
    expect(result).toContain("Hello world\n");
  });

  it("le format VTT utilise un point (pas une virgule) comme séparateur ms", () => {
    const result = toVtt([SEG_A]);
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
  });

  it("VTT n'a pas de numéros de séquence (contrairement à SRT)", () => {
    const result = toVtt([SEG_A, SEG_B]);
    // Pas de ligne "1\n" ou "2\n" — VTT ne numérote pas les cues
    expect(result).not.toMatch(/^1\n/m);
    expect(result).not.toMatch(/^2\n/m);
  });

  it("calcule correctement la fin (start + duration) en VTT", () => {
    const result = toVtt([SEG_B]);
    expect(result).toContain("00:00:02.500 --> 00:00:05.500\n");
  });

  it("VTT vs SRT différence confirmée : virgule vs point", () => {
    const srt = toSrt([SEG_A]);
    const vtt = toVtt([SEG_A]);
    // SRT → virgule
    expect(srt).toContain("00:00:00,000");
    // VTT → point
    expect(vtt).toContain("00:00:00.000");
  });
});
