// ============================================================================
// ClipsFlow Clips — hook score heuristic 0-100 virality predictor
// ============================================================================
// Pure-function scorer that grades a clip's first sentence(s) against
// a small set of "scroll-stopping hook" signals. Runs at render completion,
// persists to `clips.score`, gallery card displays it as a colored badge.
//
// Design philosophy : NO LLM call. Regex + length heuristics only.
// Adds zero wall-clock to the pipeline (~1ms) and zero cost.
//
// Signals weighted (max 100) :
//   1. Question mark in first sentence : +20 (engagement → reply)
//   2. Exclamation mark in first sentence : +15 (energy)
//   3. First word is a power-verb (stop, watch, listen, never, etc.) : +20
//   4. Sentence length 5-12 words : +20 (sweet spot)
//   5. Number / digit in first sentence : +15 (concrete, listicle hook)
//   6. Pronoun "you / tu / vous" early : +10 (direct address)
//
// Range : 0-100 ; clipped.
// Ported from VidiaFlow src/lib/clipflow/hook-score.ts (unchanged logic).
// ============================================================================

const POWER_VERBS = [
  // English
  "stop",
  "watch",
  "listen",
  "never",
  "always",
  "imagine",
  "think",
  "discover",
  "learn",
  "see",
  "remember",
  "wait",
  "look",
  // French
  "arrête",
  "regarde",
  "écoute",
  "imagine",
  "découvre",
  "apprends",
  "vois",
  "souviens",
  "attends",
  "jamais",
  "toujours",
  // Spanish (light coverage)
  "para",
  "mira",
  "escucha",
  "imagina",
  "nunca",
  "siempre",
];

const PRONOUNS = [
  "you",
  "your",
  "tu",
  "te",
  "ton",
  "ta",
  "tes",
  "vous",
  "votre",
  "vos",
  "tú",
  "tu",
];

/** First sentence approximation : split on `.`, `?`, `!` ; take the
 *  first non-empty chunk after trim. Falls back to the whole transcript
 *  when no terminal punctuation exists in the first 200 chars.
 *
 *  Exported (ClipsFlow Lot 2) : the render pipeline persists this value
 *  as `clips.hook_text` alongside the score — single source of truth
 *  for the "what sentence was scored" question. */
export function firstSentence(transcript: string): string {
  const head = transcript.slice(0, 200).trim();
  if (!head) return "";
  const match = head.match(/^[^.!?]+[.!?]/);
  return (match ? match[0] : head).trim();
}

/**
 * Compute the 0-100 hook score for a clip's transcript.
 *
 * @param transcript Plain-text transcript of the clip's audio
 *                   (Whisper output, post-merge across cues). Empty
 *                   transcripts return 0.
 * @returns Integer 0-100. Capped at both ends.
 */
export function computeHookScore(
  transcript: string | null | undefined,
): number {
  if (!transcript) return 0;
  const sentence = firstSentence(transcript);
  if (!sentence) return 0;

  const lower = sentence.toLowerCase();
  let score = 0;

  // 1. Question mark — +20
  if (sentence.includes("?")) score += 20;

  // 2. Exclamation mark — +15
  if (sentence.includes("!")) score += 15;

  // 3. Power verb at start — +20
  const firstWord = (sentence.match(/^\w+/) ?? [""])[0].toLowerCase();
  if (POWER_VERBS.includes(firstWord)) score += 20;

  // 4. Sentence length 5-12 words — +20 (peaks around 8 words)
  const wordCount = sentence.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 5 && wordCount <= 12) score += 20;
  else if (wordCount >= 3 && wordCount <= 16) score += 10; // partial credit

  // 5. Number / digit anywhere — +15
  if (/\d/.test(sentence)) score += 15;

  // 6. Pronoun (direct address) early — +10 (within first 5 words)
  const earlyTokens = lower.split(/\s+/).slice(0, 5);
  if (
    earlyTokens.some((t) =>
      PRONOUNS.includes(t.replace(/[^a-zàâçéèêëîïôûùüÿñæœ]/gi, "")),
    )
  ) {
    score += 10;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}
