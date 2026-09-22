// ============================================================================
// ClipsFlow Clips — cue translation helper (Claude Haiku 4.5)
// ============================================================================
// Groups words into display cues (3 words per cue), then translates each cue
// text from the Whisper-detected source language to the user's requested
// target language via a single Claude Haiku 4.5 call.
//
// Fail-loud : throws with `translation_partial:` or `translation_empty_cue:`
// prefixes when Anthropic fails or returns wrong line counts / empty cues.
// The cron worker matches on the shared `translation_` prefix and refunds quota.
//
// Ported from VidiaFlow src/lib/clipflow/translate-cues.ts (unchanged logic).
// Adaptation : import path `./whisper` → `./types` for WordTimestamp.
// ============================================================================

import type { WordTimestamp } from "./types";

/** A display cue : text to show + absolute start/end seconds. */
export type CueGroup = { text: string; start: number; end: number };

/**
 * Server-side allowlist of Whisper language names we will translate from/to.
 * Whisper's `detectedLanguage` can return non-Latin glyphs or mis-detected
 * pairs. Without this check the Claude prompt embeds the raw string verbatim
 * and gibberish answers pass downstream quality gates.
 */
const WHISPER_SUPPORTED_LANGUAGES = new Set([
  "french",
  "english",
  "spanish",
  "portuguese",
  "german",
  "italian",
  "dutch",
  "turkish",
  "japanese",
  "korean",
  "arabic",
  "chinese",
  "russian",
  "hindi",
  "polish",
  "romanian",
  "swedish",
  "czech",
  "greek",
  "hungarian",
  "finnish",
  "danish",
  "norwegian",
  "hebrew",
  "thai",
  "vietnamese",
  "indonesian",
  "malay",
  "swahili",
  "ukrainian",
]);

/**
 * Returns true iff the language name is in our Whisper-supported allowlist.
 */
export function isSupportedTranslateLanguage(name: string): boolean {
  return WHISPER_SUPPORTED_LANGUAGES.has(name.toLowerCase().trim());
}

/**
 * Minimal Anthropic client interface (subset of @anthropic-ai/sdk MessagesAPI).
 * Declared here so tests can pass a mock without importing the real SDK.
 */
export interface AnthropicLike {
  messages: {
    create: (params: {
      model: string;
      max_tokens: number;
      messages: { role: "user"; content: string }[];
    }) => Promise<{
      content: { type: string; text?: string }[];
    }>;
  };
}

function defaultAnthropicClient(): AnthropicLike {
  if (process.env.CLIPS_AI_BUDGET_AUTHORIZED !== "true") {
    throw new Error(
      "paid_ai_not_authorized: set CLIPS_AI_BUDGET_AUTHORIZED=true only after approving the provider budget",
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "translation_unavailable: ANTHROPIC_API_KEY is not configured",
    );
  }
  // Lazy require avoids bundling @anthropic-ai/sdk in paths that never use
  // translation. The SDK is already a dep so no install cost — just deferred.
  // (Fix Lot 3 : le disable-next-line ne couvrait que la 1re ligne de
  // l'assignation multi-ligne reformatée par prettier — require regroupé
  // sur une seule ligne désactivable.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@anthropic-ai/sdk");
  const Anthropic = sdk.default ?? sdk;
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }) as AnthropicLike;
}

/**
 * Build display cues from words (3 words per cue by default).
 * Extracted as a pure helper so tests can verify grouping independently.
 */
export function buildCueGroups(
  words: WordTimestamp[],
  wordsPerCue = 3,
): CueGroup[] {
  const cues: CueGroup[] = [];
  for (let i = 0; i < words.length; i += wordsPerCue) {
    const g = words.slice(i, i + wordsPerCue);
    cues.push({
      text: g.map((w) => w.text).join(" "),
      start: g[0].start,
      end: g[g.length - 1].end,
    });
  }
  return cues;
}

/**
 * Group words into display cues then translate each cue text from
 * `fromLang` to `toLang` via Claude Haiku 4.5 (single batched call).
 * Timestamps are preserved 1:1 from the source words.
 *
 * Returns source cues unchanged ONLY when no translation is required :
 *   - `fromLang === toLang` (no translation needed)
 *   - `words` is empty
 *
 * Throws with a `translation_partial:` or `translation_empty_cue:` prefix
 * when Anthropic fails, returns the wrong line count, or returns an empty
 * cue text. The cron worker recognises both prefixes and refunds quota.
 *
 * @param words       Word-level timestamps from Whisper auto-detect.
 * @param fromLang    Source language name (Whisper convention, e.g. "french").
 * @param toLang      Target language name (e.g. "english", "german").
 * @param wordsPerCue Words per display cue (default 3).
 * @param client      Optional injected client for tests.
 */
export async function translateCues(
  words: WordTimestamp[],
  fromLang: string,
  toLang: string,
  wordsPerCue = 3,
  client?: AnthropicLike,
): Promise<CueGroup[]> {
  if (words.length === 0) return [];

  const cues = buildCueGroups(words, wordsPerCue);

  if (fromLang === toLang) return cues;

  // Refuse to call Claude when either language is outside our allowlist.
  if (
    !isSupportedTranslateLanguage(fromLang) ||
    !isSupportedTranslateLanguage(toLang)
  ) {
    throw new Error(
      `translation_unsupported_language: from='${fromLang.slice(0, 40)}' to='${toLang.slice(0, 40)}'. ` +
        `Translation requires both languages to be in the Whisper allowlist. Aborting to avoid gibberish output.`,
    );
  }

  const numbered = cues.map((c, i) => `${i + 1}. ${c.text}`).join("\n");
  const prompt = [
    `Translate each numbered subtitle line from ${fromLang} to ${toLang}.`,
    `Keep the SAME numbering. One line per number.`,
    `Translate naturally for spoken speech (not literal).`,
    `Output ONLY the numbered translations, no preamble.\n`,
    numbered,
  ].join(" ");

  let rawText: string;
  try {
    const anthropic = client ?? defaultAnthropicClient();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    rawText = response.content
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("");
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    throw new Error(
      `translation_partial: Anthropic call failed during cue translation (${fromLang} → ${toLang}). ${msg.slice(0, 200)}`,
    );
  }

  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s*/.test(l));

  if (lines.length !== cues.length) {
    throw new Error(
      `translation_partial: Claude returned ${lines.length} cues for ${cues.length} source cues. Aborting to avoid mixed-language subtitles.`,
    );
  }

  const translated = cues.map((c, i) => ({
    text: lines[i].replace(/^\d+\.\s*/, "").trim(),
    start: c.start,
    end: c.end,
  }));

  const emptyIdx = translated.findIndex((c) => !c.text || c.text.trim() === "");
  if (emptyIdx !== -1) {
    throw new Error(
      `translation_empty_cue: Claude returned empty text for cue ${emptyIdx + 1}/${translated.length}. Aborting to avoid blank subtitle gaps.`,
    );
  }

  return translated;
}
