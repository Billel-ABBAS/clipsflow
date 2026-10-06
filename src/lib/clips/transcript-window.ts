import type { WordTimestamp } from "./whisper";

/** Select and rebase existing word-level timestamps into a source window. */
export function transcriptWindow(
  value: unknown,
  startSeconds: number,
  endSeconds: number,
): WordTimestamp[] | null {
  if (
    !Array.isArray(value) ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    return null;
  }

  const words: WordTimestamp[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const word = entry as Record<string, unknown>;
    if (
      typeof word.text !== "string" ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      (word.start as number) < 0 ||
      (word.end as number) <= (word.start as number)
    ) {
      continue;
    }

    const absoluteStart = word.start as number;
    const absoluteEnd = word.end as number;
    if (absoluteEnd <= startSeconds || absoluteStart >= endSeconds) continue;
    const text = word.text
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .trim();
    if (!text) continue;
    const start = Math.max(0, absoluteStart - startSeconds);
    const end = Math.min(endSeconds, absoluteEnd) - startSeconds;
    if (end <= start) continue;
    words.push({
      text,
      start: Math.round(start * 1_000) / 1_000,
      end: Math.round(end * 1_000) / 1_000,
    });
  }
  return words.length > 0 ? words : null;
}
