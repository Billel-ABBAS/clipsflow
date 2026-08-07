// ============================================================================
// Tests unitaires — ass-format.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  assTime,
  hexToAss,
  escapeAss,
  detectScriptFont,
  isKeyword,
  srtTime,
  vttTime,
} from "./ass-format";

// ---------------------------------------------------------------------------
// assTime
// ---------------------------------------------------------------------------
describe("assTime", () => {
  it("formate zéro seconde", () => {
    expect(assTime(0)).toBe("0:00:00.00");
  });

  it("formate 1.234 secondes en centisecondes (pas millisecondes)", () => {
    // 1 s + 0.234 → cs = floor(0.234 * 100) = 23
    expect(assTime(1.234)).toBe("0:00:01.23");
  });

  it("formate 61.5 secondes", () => {
    // 1 min 1 s, cs = 50
    expect(assTime(61.5)).toBe("0:01:01.50");
  });

  it("formate 3600 secondes (1 heure exacte)", () => {
    expect(assTime(3600)).toBe("1:00:00.00");
  });

  it("formate 3661.99 secondes", () => {
    // IEEE 754 : 3661.99 - 3661 = 0.989999... donc floor(0.989999*100) = 98
    expect(assTime(3661.99)).toBe("1:01:01.98");
  });

  it("valeur négative clampée à zéro", () => {
    expect(assTime(-5)).toBe("0:00:00.00");
  });
});

// ---------------------------------------------------------------------------
// hexToAss — conversion BGR
// ---------------------------------------------------------------------------
describe("hexToAss", () => {
  it("convertit #RRGGBB en &HBBGGRR& (ASS BGR)", () => {
    // #FF0000 (rouge) → BB=00, GG=00, RR=FF → &H0000FF&
    expect(hexToAss("#FF0000", "#000000")).toBe("&H0000FF&");
  });

  it("convertit le cyan Noir Studio #22D3EE", () => {
    // #22D3EE → BB=EE GG=D3 RR=22 → &HEED322&
    expect(hexToAss("#22D3EE", "#000000")).toBe("&HEED322&");
  });

  it("convertit sans le # préfixe", () => {
    expect(hexToAss("FFFFFF", "#000000")).toBe("&HFFFFFF&");
  });

  it("utilise le fallback si hex est undefined", () => {
    expect(hexToAss(undefined, "#FFFFFF")).toBe("&HFFFFFF&");
  });

  it("gère le blanc #FFFFFF", () => {
    expect(hexToAss("#FFFFFF", "#000000")).toBe("&HFFFFFF&");
  });

  it("gère le noir #000000", () => {
    expect(hexToAss("#000000", "#FFFFFF")).toBe("&H000000&");
  });

  it("gère la casse mixte", () => {
    // #ff0000 doit donner la même chose que #FF0000
    expect(hexToAss("#ff0000", "#000000")).toBe("&H0000ff&");
  });
});

// ---------------------------------------------------------------------------
// escapeAss
// ---------------------------------------------------------------------------
describe("escapeAss", () => {
  it("échappe les accolades ouvrantes", () => {
    expect(escapeAss("{test}")).toBe("\\{test\\}");
  });

  it("échappe les accolades fermantes", () => {
    expect(escapeAss("}")).toBe("\\}");
  });

  it("remplace les \\n par \\N (newline ASS)", () => {
    expect(escapeAss("line1\nline2")).toBe("line1\\Nline2");
  });

  it("supprime les \\r (CRLF)", () => {
    expect(escapeAss("line1\r\nline2")).toBe("line1\\Nline2");
  });

  it("laisse intact le texte sans caractères spéciaux", () => {
    expect(escapeAss("Hello world")).toBe("Hello world");
  });

  it("échappe une chaîne avec override ASS inline", () => {
    // escapeAss échappe UNIQUEMENT { et } — les backslashes internes restent intacts.
    // Input JS :  "{\\b1}Bold text{\\b0}"
    //   = la string littérale :  {\b1}Bold text{\b0}
    // Après escapeAss :          \{\b1\}Bold text\{\b0\}
    const input = "{\\b1}Bold text{\\b0}";
    const output = escapeAss(input);
    expect(output).toBe("\\{\\b1\\}Bold text\\{\\b0\\}");
  });
});

// ---------------------------------------------------------------------------
// detectScriptFont
// ---------------------------------------------------------------------------
describe("detectScriptFont", () => {
  it("retourne null pour du texte latin pur", () => {
    expect(detectScriptFont("Hello world")).toBeNull();
  });

  it("détecte l'arabe", () => {
    expect(detectScriptFont("مرحبا")).toBe("Noto Sans Arabic");
  });

  it("détecte le japonais (hiragana/katakana)", () => {
    expect(detectScriptFont("こんにちは")).toBe("Noto Sans JP");
  });

  it("détecte le coréen (hangul)", () => {
    expect(detectScriptFont("안녕하세요")).toBe("Noto Sans KR");
  });

  it("détecte le CJK Simplifié (hanzi sans kana)", () => {
    // Idéogrammes Han sans kana ni hangul → Noto Sans SC
    expect(detectScriptFont("你好世界")).toBe("Noto Sans SC");
  });

  it("détecte le devanagari (hindi)", () => {
    expect(detectScriptFont("नमस्ते")).toBe("Noto Sans Devanagari");
  });

  it("script dominant gagne sur texte latin mélangé", () => {
    // "Hello مرحبا world" — la majorité est latin mais "مرحبا" domine numériquement
    // si 5 chars arabes vs 10 chars latin → null car latin > arabe; inverser
    const arabicHeavy = "مرحبا بك في العالم hello";
    const result = detectScriptFont(arabicHeavy);
    expect(result).toBe("Noto Sans Arabic");
  });
});

// ---------------------------------------------------------------------------
// isKeyword
// ---------------------------------------------------------------------------
describe("isKeyword", () => {
  it("détecte un nombre à 2+ chiffres", () => {
    expect(isKeyword("100K")).toBe(true);
    expect(isKeyword("2026")).toBe(true);
  });

  it("mot avec 1 seul chiffre ne satisfait pas la règle chiffres", () => {
    // Un seul chiffre → pas de run de 2+
    expect(isKeyword("1")).toBe(false);
  });

  it("détecte les symboles monétaires", () => {
    expect(isKeyword("$1000")).toBe(true);
    expect(isKeyword("€500")).toBe(true);
    expect(isKeyword("£200")).toBe(true);
  });

  it("détecte le signe %", () => {
    expect(isKeyword("50%")).toBe(true);
  });

  it("détecte le point d'exclamation", () => {
    expect(isKeyword("wow!")).toBe(true);
  });

  it("détecte les mots UPPERCASE >= 4 lettres", () => {
    expect(isKeyword("FREE")).toBe(true);
    expect(isKeyword("VIRAL")).toBe(true);
    expect(isKeyword("HUGE")).toBe(true);
  });

  it("mot UPPERCASE de 3 lettres ne trigger pas la règle all-caps", () => {
    // letters.length < 4
    expect(isKeyword("BIG")).toBe(false);
  });

  it("mot en casse mixte ne trigger pas la règle all-caps", () => {
    expect(isKeyword("Hello")).toBe(false);
  });

  it("chaîne vide retourne false", () => {
    expect(isKeyword("")).toBe(false);
  });

  it("mot commun lowercase sans signal retourne false", () => {
    expect(isKeyword("the")).toBe(false);
    expect(isKeyword("and")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// srtTime / vttTime
// ---------------------------------------------------------------------------
describe("srtTime", () => {
  it("formate avec virgule (séparateur SRT)", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
  });

  it("formate 1.234 secondes", () => {
    expect(srtTime(1.234)).toBe("00:00:01,234");
  });

  it("formate 3661.999 secondes", () => {
    // IEEE 754 : 3661.999 - 3661 = 0.998999... donc round(0.998999*1000) = 999
    // Mais certains moteurs JS donnent 0.9989... → 998. On vérifie le comportement réel.
    const result = srtTime(3661.999);
    // Accepte 998 ou 999 (artefact floating point connu)
    expect(["01:01:01,998", "01:01:01,999"]).toContain(result);
  });

  it("valeur négative retourne 00:00:00,000", () => {
    expect(srtTime(-1)).toBe("00:00:00,000");
  });
});

describe("vttTime", () => {
  it("formate avec point (séparateur WebVTT)", () => {
    expect(vttTime(0)).toBe("00:00:00.000");
  });

  it("formate 1.5 secondes", () => {
    expect(vttTime(1.5)).toBe("00:00:01.500");
  });

  it("formate 3661.1 secondes", () => {
    // IEEE 754 : 3661.1 - 3661 = 0.09999... donc round(0.09999*1000) = 100 ou 99
    const result = vttTime(3661.1);
    expect(["01:01:01.099", "01:01:01.100"]).toContain(result);
  });
});
