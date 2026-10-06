import { describe, expect, it } from "vitest";

import { suggestClipMoments } from "./suggestions";

describe("suggestClipMoments", () => {
  it("retourne au plus trois passages temporels distincts et estime leur coût", () => {
    const words = [
      { text: "Stop", start: 1, end: 2 },
      { text: "et", start: 2.1, end: 2.2 },
      { text: "écoute", start: 2.3, end: 3 },
      { text: "cette", start: 3.1, end: 3.4 },
      { text: "histoire", start: 3.5, end: 4.1 },
      { text: "incroyable.", start: 4.2, end: 5 },
      { text: "Voici", start: 22, end: 22.5 },
      { text: "3", start: 22.6, end: 22.8 },
      { text: "raisons", start: 22.9, end: 23.5 },
      { text: "pour", start: 23.6, end: 23.8 },
      { text: "lesquelles", start: 23.9, end: 24.5 },
      { text: "tu", start: 24.6, end: 24.7 },
      { text: "devrais", start: 24.8, end: 25.2 },
      { text: "continuer.", start: 25.3, end: 26 },
      { text: "Pourquoi", start: 44, end: 44.5 },
      { text: "est-ce", start: 44.6, end: 45 },
      { text: "important", start: 45.1, end: 46 },
      { text: "pour", start: 46.1, end: 46.3 },
      { text: "toi", start: 46.4, end: 46.8 },
      { text: "?", start: 46.9, end: 47 },
    ];

    const suggestions = suggestClipMoments(words, 0, 60);
    expect(suggestions).toHaveLength(3);
    expect(
      suggestions.every((item) => item.end_seconds - item.start_seconds >= 10),
    ).toBe(true);
    expect(suggestions.every((item) => item.estimated_cost_usd > 0)).toBe(true);
    expect(new Set(suggestions.map((item) => item.start_seconds)).size).toBe(3);
  });

  it("ignore untrusted or malformed timestamp data", () => {
    expect(suggestClipMoments("not a transcript", 0, 60)).toEqual([]);
    expect(
      suggestClipMoments([{ text: "bad", start: 20, end: 10 }], 0, 60),
    ).toEqual([]);
  });

  it("ne propose jamais plus de trois passages", () => {
    const words = Array.from({ length: 8 }, (_, index) => ({
      text: `Phrase ${index} suffisamment longue?`,
      start: index * 15,
      end: index * 15 + 4,
    }));
    expect(suggestClipMoments(words, 0, 120)).toHaveLength(3);
  });
});
