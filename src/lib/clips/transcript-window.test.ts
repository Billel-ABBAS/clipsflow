import { describe, expect, it } from "vitest";

import { transcriptWindow } from "./transcript-window";

describe("transcriptWindow", () => {
  it("filters source words, clips boundary overlap, and rebases timestamps", () => {
    expect(
      transcriptWindow(
        [
          { text: "before", start: 4, end: 4.5 },
          { text: "first", start: 9.8, end: 10.2 },
          { text: "next", start: 10.25, end: 10.75 },
          { text: "after", start: 20, end: 20.5 },
        ],
        10,
        20,
      ),
    ).toEqual([
      { text: "first", start: 0, end: 0.2 },
      { text: "next", start: 0.25, end: 0.75 },
    ]);
  });

  it("returns null for absent or malformed cached transcripts", () => {
    expect(transcriptWindow(null, 0, 10)).toBeNull();
    expect(
      transcriptWindow([{ text: "", start: 2, end: 1 }], 0, 10),
    ).toBeNull();
  });
});
