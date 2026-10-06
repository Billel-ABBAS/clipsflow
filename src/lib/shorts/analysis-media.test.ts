import { describe, expect, it } from "vitest";

import { buildLongformAudioChunkRanges } from "./analysis-media";

describe("long-form source chunking", () => {
  it("covers the complete duration with bounded, overlapping audio segments", () => {
    expect(buildLongformAudioChunkRanges(1_200)).toEqual([
      {
        index: 0,
        start_seconds: 0,
        end_seconds: 600,
        skip_leading_seconds: 0,
      },
      {
        index: 1,
        start_seconds: 570,
        end_seconds: 1_170,
        skip_leading_seconds: 30,
      },
      {
        index: 2,
        start_seconds: 1_140,
        end_seconds: 1_200,
        skip_leading_seconds: 30,
      },
    ]);
  });

  it("rejects invalid duration and overlapping chunk settings", () => {
    expect(() => buildLongformAudioChunkRanges(0)).toThrow(
      "shorts_audio_chunk_options_invalid",
    );
    expect(() => buildLongformAudioChunkRanges(100, 30, 30)).toThrow(
      "shorts_audio_chunk_options_invalid",
    );
  });
});
