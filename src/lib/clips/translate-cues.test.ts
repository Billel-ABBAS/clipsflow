import { describe, expect, it, vi } from "vitest";
import {
  buildCueGroups,
  isSupportedTranslateLanguage,
  translateCues,
  type OpenAITranslationClient,
} from "./translate-cues";

const words = [
  { text: "Bonjour", start: 0, end: 0.4 },
  { text: "tout", start: 0.4, end: 0.7 },
  { text: "le", start: 0.7, end: 0.9 },
  { text: "monde", start: 0.9, end: 1.3 },
];

function clientFor(payload: unknown): {
  client: OpenAITranslationClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({
    status: "completed",
    output_text: JSON.stringify(payload),
  });
  return { client: { responses: { create } }, create };
}

describe("translateCues", () => {
  it("groups source words into timestamp-preserving cues", () => {
    expect(buildCueGroups(words, 3)).toEqual([
      { text: "Bonjour tout le", start: 0, end: 0.9 },
      { text: "monde", start: 0.9, end: 1.3 },
    ]);
  });

  it("accepts supported Whisper language names only", () => {
    expect(isSupportedTranslateLanguage("French")).toBe(true);
    expect(isSupportedTranslateLanguage(" klingon ")).toBe(false);
  });

  it("does not call OpenAI when translation is unnecessary", async () => {
    const { client, create } = clientFor({ translations: [] });

    await expect(
      translateCues(words, "french", "french", 3, client),
    ).resolves.toEqual(buildCueGroups(words, 3));
    expect(create).not.toHaveBeenCalled();
  });

  it("uses schema-constrained, non-stored OpenAI output and preserves cue timing", async () => {
    const { client, create } = clientFor({
      translations: [
        { index: 1, text: "Hello everyone" },
        { index: 2, text: "world" },
      ],
    });

    await expect(
      translateCues(words, "french", "english", 3, client),
    ).resolves.toEqual([
      { text: "Hello everyone", start: 0, end: 0.9 },
      { text: "world", start: 0.9, end: 1.3 },
    ]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5-mini",
        store: false,
        text: expect.objectContaining({
          format: expect.objectContaining({
            type: "json_schema",
            strict: true,
          }),
        }),
      }),
    );
  });

  it("fails closed when OpenAI omits or reorders a cue", async () => {
    const { client } = clientFor({
      translations: [
        { index: 2, text: "Hello" },
        { index: 1, text: "world" },
      ],
    });

    await expect(
      translateCues(words, "french", "english", 3, client),
    ).rejects.toThrow("translation_partial:");
  });

  it("fails closed when OpenAI returns a blank translation", async () => {
    const { client } = clientFor({
      translations: [
        { index: 1, text: "Hello" },
        { index: 2, text: " " },
      ],
    });

    await expect(
      translateCues(words, "french", "english", 3, client),
    ).rejects.toThrow("translation_empty_cue:");
  });
});
