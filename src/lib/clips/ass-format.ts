// ============================================================================
// ClipsFlow Clips — ASS / SRT / WebVTT format helpers (pure, zero deps)
// ============================================================================
// Pure formatting / detection helpers with no side effects, no fs, no spawn.
// Safe to import from any code path (server, tests).
//
// Ported from VidiaFlow src/lib/clipflow/ass-format.ts (unchanged logic).
// ============================================================================

/**
 * ASS time format : H:MM:SS.cs (centiseconds, NOT milliseconds).
 * Example : 1.234 seconds → "0:00:01.23".
 */
export function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total - Math.floor(total)) * 100);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * Convert "#RRGGBB" (any case, optional `#`) → "&H<BB><GG><RR>&"
 * (ASS BGR, no alpha). Used inline in `\c` overrides AND in the
 * style block PrimaryColour / SecondaryColour / OutlineColour fields.
 */
export function hexToAss(hex: string | undefined, fallback: string): string {
  const h = (hex ?? fallback).replace("#", "").padStart(6, "0").slice(-6);
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

/**
 * Detect dominant Unicode script in a cue text. Returns the ASS family
 * name of the bundled Noto Sans font that covers that script, or `null`
 * if the text is plain Latin (Inter / user-picked font handles it).
 */
export function detectScriptFont(text: string): string | null {
  let arabic = 0,
    hebrew = 0,
    thai = 0,
    devanagari = 0,
    cjkSC = 0,
    cjkJP = 0,
    cjkKR = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0600 && cp <= 0x06ff) arabic++;
    else if (cp >= 0x0590 && cp <= 0x05ff) hebrew++;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++;
    else if (cp >= 0x0900 && cp <= 0x097f) devanagari++;
    // Hiragana/Katakana → JP exclusively
    else if (cp >= 0x3040 && cp <= 0x30ff) cjkJP++;
    // Hangul syllables + Jamo → KR exclusively
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff))
      cjkKR++;
    // Han ideographs → SC by default (when no kana/hangul present)
    else if (cp >= 0x4e00 && cp <= 0x9fff) cjkSC++;
  }
  const scores: [string, number][] = [
    ["Noto Sans Arabic", arabic],
    ["Noto Sans Hebrew", hebrew],
    ["Noto Sans Thai", thai],
    ["Noto Sans Devanagari", devanagari],
    ["Noto Sans JP", cjkJP],
    ["Noto Sans KR", cjkKR],
    ["Noto Sans SC", cjkSC],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : null;
}

/**
 * Detect whether a word qualifies as a "keyword" — important word
 * that gets a colour pop on top of the karaoke advance.
 *
 * Heuristic (no LLM call) :
 *   - Word contains a digit run of >= 2 chars (10, 100K, 1M, 2026)
 *   - Word contains a currency symbol ($, €, £, ¥)
 *   - Word contains a percent sign (%)
 *   - Word contains an exclamation mark (!)
 *   - Word is fully UPPERCASE AND length >= 4 (FREE, VIRAL, HUGE)
 *
 * MUST be called against the ORIGINAL-case word, BEFORE any UPPERCASE
 * transform — otherwise the all-caps branch matches every word.
 */
export function isKeyword(word: string): boolean {
  if (!word) return false;
  if (/\d{2,}/.test(word)) return true;
  if (/[$€£¥]/.test(word)) return true;
  if (/%/.test(word)) return true;
  if (/!/.test(word)) return true;
  const letters = word.replace(/[^\p{L}]/gu, "");
  if (
    letters.length >= 4 &&
    letters === letters.toLocaleUpperCase("fr-FR") &&
    letters !== letters.toLocaleLowerCase("fr-FR")
  ) {
    return true;
  }
  return false;
}

/**
 * Escape ASS dialogue text. ASS uses `{` `}` for override blocks and `\N`
 * for line breaks.
 */
export function escapeAss(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

/**
 * Format a number of seconds as SRT timestamp HH:MM:SS,mmm.
 * SRT requires comma as decimal separator.
 */
export function srtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Format a number of seconds as WebVTT timestamp HH:MM:SS.mmm.
 * WebVTT uses dot as decimal separator.
 */
export function vttTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}
