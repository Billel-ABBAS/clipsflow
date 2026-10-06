import { computeClipCost } from "./cost";
import { computeHookScore } from "./hook-score";
import type { WordTimestamp } from "./whisper";

export interface ClipMomentSuggestion {
  start_seconds: number;
  end_seconds: number;
  text: string;
  score: number;
  estimated_cost_usd: number;
}

function validWords(value: unknown): WordTimestamp[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((word): word is Record<string, unknown> =>
      Boolean(word && typeof word === "object"),
    )
    .map((word) => ({
      text: typeof word.text === "string" ? word.text.trim() : "",
      start: typeof word.start === "number" ? word.start : Number.NaN,
      end: typeof word.end === "number" ? word.end : Number.NaN,
    }))
    .filter(
      (word) =>
        word.text.length > 0 &&
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.start >= 0 &&
        word.end > word.start,
    )
    .sort((a, b) => a.start - b.start)
    .slice(0, 20_000);
}

function sentenceGroups(words: WordTimestamp[]): WordTimestamp[][] {
  const groups: WordTimestamp[][] = [];
  let current: WordTimestamp[] = [];
  for (const word of words) {
    current.push(word);
    if (/[.!?…]["')\]]*$/u.test(word.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function intervalsOverlapTooMuch(
  left: ClipMomentSuggestion,
  right: ClipMomentSuggestion,
): boolean {
  const overlap = Math.max(
    0,
    Math.min(left.end_seconds, right.end_seconds) -
      Math.max(left.start_seconds, right.start_seconds),
  );
  const shorter = Math.min(
    left.end_seconds - left.start_seconds,
    right.end_seconds - right.start_seconds,
  );
  return shorter > 0 && overlap / shorter >= 0.6;
}

/** Rank at most three non-overlapping passages from already stored words. */
export function suggestClipMoments(
  transcriptWords: unknown,
  sourceStart: number,
  sourceEnd: number,
): ClipMomentSuggestion[] {
  const words = validWords(transcriptWords).filter(
    (word) => word.start >= sourceStart && word.end <= sourceEnd,
  );
  const candidates: ClipMomentSuggestion[] = [];

  for (const group of sentenceGroups(words)) {
    const text = group
      .map((word) => word.text)
      .join(" ")
      .slice(0, 500)
      .trim();
    if (text.length < 20) continue;

    let start = Math.max(sourceStart, Math.floor(group[0].start - 4));
    let end = Math.min(sourceEnd, Math.ceil(group[group.length - 1].end + 4));
    if (end - start > 60) end = start + 60;
    if (end - start < 12) {
      end = Math.min(sourceEnd, start + 12);
      start = Math.max(sourceStart, end - 12);
    }
    const duration = end - start;
    if (duration < 10 || duration > 180) continue;

    candidates.push({
      start_seconds: start,
      end_seconds: end,
      text,
      score: computeHookScore(text),
      estimated_cost_usd: computeClipCost(duration),
    });
  }

  candidates.sort(
    (a, b) => b.score - a.score || a.start_seconds - b.start_seconds,
  );
  const selected: ClipMomentSuggestion[] = [];
  for (const candidate of candidates) {
    if (selected.some((item) => intervalsOverlapTooMuch(item, candidate)))
      continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected;
}
