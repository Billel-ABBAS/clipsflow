import { describe, expect, it } from "vitest";

import {
  assertLongformEpisodeDuration,
  buildDeterministicCandidateWindows,
  buildLongformAnalysisPlan,
  combineShortsAudioVisualScore,
  chunkLongformTranscript,
  DEFAULT_LONGFORM_ANALYSIS_INSTRUCTIONS,
  LONGFORM_ANALYSIS_RESPONSE_VERSION,
  LongformAnalysisValidationError,
  MAX_LONGFORM_ANALYSIS_INSTRUCTIONS_LENGTH,
  normalizeLongformAnalysisInstructions,
  normalizeLongformTranscriptWords,
  parseLongformAnalysisResponse,
  rankShortsMomentsWithVisualScores,
  SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS,
} from "./longform-analysis";
import type { WordTimestamp } from "./whisper";

function word(text: string, start: number, end: number): WordTimestamp {
  return { text, start, end };
}

describe("long-form episode duration", () => {
  it("accepts the inclusive 20 minute and two hour bounds", () => {
    expect(assertLongformEpisodeDuration(20 * 60)).toBe(20 * 60);
    expect(assertLongformEpisodeDuration(2 * 60 * 60)).toBe(2 * 60 * 60);
  });

  it("rejects short, overlong, and non-finite sources before analysis", () => {
    for (const duration of [20 * 60 - 0.001, 2 * 60 * 60 + 0.001, NaN]) {
      expect(() => assertLongformEpisodeDuration(duration)).toThrow(
        LongformAnalysisValidationError,
      );
    }
  });
});

describe("audio + video candidate ranking", () => {
  it("keeps audio as the primary score and bounds both signals", () => {
    expect(SHORTS_AUDIO_VISUAL_SCORE_WEIGHTS).toEqual({
      audio: 0.8,
      visual: 0.2,
    });
    expect(combineShortsAudioVisualScore(90, 50)).toBe(82);
    expect(() => combineShortsAudioVisualScore(90, 101)).toThrow(
      LongformAnalysisValidationError,
    );
  });

  it("reorders audio-ranked candidates when visual evidence changes the result", () => {
    const moments = [
      { candidate_id: "candidate-001", score: 92, title: "Audio lead" },
      { candidate_id: "candidate-002", score: 80, title: "Visual lead" },
    ];
    const ranked = rankShortsMomentsWithVisualScores(
      moments,
      new Map([
        ["candidate-001", 10],
        ["candidate-002", 100],
      ]),
    );
    expect(
      ranked.map(({ candidate_id, score }) => [candidate_id, score]),
    ).toEqual([
      ["candidate-002", 84],
      ["candidate-001", 76],
    ]);
  });

  it("preserves the audio ranking when a visual score is missing", () => {
    const moments = [
      { candidate_id: "candidate-001", score: 92 },
      { candidate_id: "candidate-002", score: 80 },
    ];
    expect(
      rankShortsMomentsWithVisualScores(moments, new Map()).map(
        ({ candidate_id }) => candidate_id,
      ),
    ).toEqual(["candidate-001", "candidate-002"]);
  });
});

describe("instruction and transcript normalization", () => {
  it("uses a safe default for missing or blank user direction", () => {
    expect(normalizeLongformAnalysisInstructions(undefined)).toBe(
      DEFAULT_LONGFORM_ANALYSIS_INSTRUCTIONS,
    );
    expect(normalizeLongformAnalysisInstructions(" \n\t ")).toBe(
      DEFAULT_LONGFORM_ANALYSIS_INSTRUCTIONS,
    );
  });

  it("collapses whitespace, removes controls, and bounds instructions", () => {
    expect(
      normalizeLongformAnalysisInstructions(
        "  Focus\n\ton the  \u0000 strongest story beat.  ",
      ),
    ).toBe("Focus on the strongest story beat.");
    expect(
      normalizeLongformAnalysisInstructions(
        "x".repeat(MAX_LONGFORM_ANALYSIS_INSTRUCTIONS_LENGTH + 25),
      ),
    ).toHaveLength(MAX_LONGFORM_ANALYSIS_INSTRUCTIONS_LENGTH);
  });

  it("drops malformed words and sorts valid timestamps without mutating input", () => {
    const input = [
      word("later", 20, 21),
      word("  first\n", 1, 2),
      { text: "bad", start: 3, end: 3 } as WordTimestamp,
    ];
    const normalized = normalizeLongformTranscriptWords(input);

    expect(normalized).toEqual([
      { text: "first", start: 1, end: 2 },
      { text: "later", start: 20, end: 21 },
    ]);
    expect(input[0]).toEqual(word("later", 20, 21));
  });
});

describe("long-form transcript chunking", () => {
  it("covers the episode timeline and repeats boundary context in the overlap", () => {
    const chunks = chunkLongformTranscript(
      [
        word("opening", 0, 0.5),
        word("shared", 550, 551),
        word("middle", 600, 601),
        word("tail", 1_100, 1_101),
      ],
      {
        episodeDurationSeconds: 1_200,
        chunkDurationSeconds: 600,
        overlapSeconds: 60,
      },
    );

    expect(
      chunks.map((chunk) => [chunk.id, chunk.start_seconds, chunk.end_seconds]),
    ).toEqual([
      ["chunk-001", 0, 600],
      ["chunk-002", 540, 1_140],
      ["chunk-003", 1_080, 1_200],
    ]);
    expect(chunks[0].transcript).toContain("shared");
    expect(chunks[1].transcript).toContain("shared");
    expect(chunks[2].transcript).toContain("tail");
  });

  it("rejects an overlap that cannot make progress", () => {
    expect(() =>
      chunkLongformTranscript([], {
        episodeDurationSeconds: 1_200,
        chunkDurationSeconds: 120,
        overlapSeconds: 120,
      }),
    ).toThrow(LongformAnalysisValidationError);
  });
});

describe("deterministic candidate windows", () => {
  const chronologicalWords = Array.from({ length: 12 }, (_, index) =>
    word(`w${index}`, index * 100 + 5, index * 100 + 6),
  );

  it("uses stable IDs and chronological fixed windows", () => {
    const options = {
      episodeDurationSeconds: 1_200,
      windowDurationSeconds: 120,
      overlapSeconds: 20,
      minDurationSeconds: 20,
    };
    const candidates = buildDeterministicCandidateWindows(
      chronologicalWords,
      options,
    );

    expect(candidates).toHaveLength(12);
    expect(candidates[0]).toMatchObject({
      id: "candidate-001",
      start_seconds: 0,
      end_seconds: 120,
      transcript: "w0 w1",
    });
    expect(candidates.at(-1)).toMatchObject({
      id: "candidate-012",
      start_seconds: 1_100,
      end_seconds: 1_200,
      transcript: "w11",
    });
    expect(
      buildDeterministicCandidateWindows(
        [...chronologicalWords].reverse(),
        options,
      ),
    ).toEqual(candidates);
  });

  it("composes a provider-ready plan without calling a provider", () => {
    const plan = buildLongformAnalysisPlan({
      episodeDurationSeconds: 1_200,
      transcriptWords: chronologicalWords,
      userInstructions: "  Favor\n  educational moments ",
      chunkDurationSeconds: 600,
      chunkOverlapSeconds: 60,
      candidateWindowSeconds: 120,
      candidateOverlapSeconds: 20,
    });

    expect(plan.user_instructions).toBe("Favor educational moments");
    expect(plan.transcript_chunks).toHaveLength(3);
    expect(plan.candidate_windows[0]?.id).toBe("candidate-001");
  });
});

describe("strict structured AI analysis response", () => {
  const candidates = buildDeterministicCandidateWindows(
    [word("first", 1, 2), word("second", 101, 102)],
    {
      episodeDurationSeconds: 1_200,
      windowDurationSeconds: 120,
      overlapSeconds: 20,
    },
  );

  const validResponse = {
    version: LONGFORM_ANALYSIS_RESPONSE_VERSION,
    summary: "Two clear moments are suitable for short-form edits.",
    moments: [
      {
        candidate_id: "candidate-001",
        score: 93,
        proposed_title: "A concise first takeaway",
        hook: "Start with the clear first statement.",
        rationale:
          "The opening is self-contained and immediately understandable.",
        music_mood: "energetic",
        motion_direction:
          "Punch in on the opening phrase, then use kinetic captions.",
      },
      {
        candidate_id: "candidate-002",
        score: 84,
        proposed_title: "A useful second takeaway",
        hook: "Follow with the second concise insight.",
        rationale:
          "It offers a distinct follow-up moment without repeating the opener.",
        music_mood: "warm",
        motion_direction: "Use a subtle zoom and highlight the key terms.",
      },
    ],
  };

  it("accepts only candidate IDs generated locally", () => {
    expect(parseLongformAnalysisResponse(validResponse, candidates)).toEqual(
      validResponse,
    );
  });

  it("rejects unknown fields, invented IDs, duplicate choices, and rising scores", () => {
    expect(() =>
      parseLongformAnalysisResponse(
        { ...validResponse, unexpected: true },
        candidates,
      ),
    ).toThrow(LongformAnalysisValidationError);

    expect(() =>
      parseLongformAnalysisResponse(
        {
          ...validResponse,
          moments: [
            { ...validResponse.moments[0], candidate_id: "candidate-999" },
          ],
        },
        candidates,
      ),
    ).toThrow(/unknown candidate ID/);

    expect(() =>
      parseLongformAnalysisResponse(
        {
          ...validResponse,
          moments: [
            validResponse.moments[0],
            { ...validResponse.moments[1], candidate_id: "candidate-001" },
          ],
        },
        candidates,
      ),
    ).toThrow(/more than once/);

    expect(() =>
      parseLongformAnalysisResponse(
        {
          ...validResponse,
          moments: [
            { ...validResponse.moments[0], score: 80 },
            { ...validResponse.moments[1], score: 90 },
          ],
        },
        candidates,
      ),
    ).toThrow(/highest to lowest/);
  });
});
