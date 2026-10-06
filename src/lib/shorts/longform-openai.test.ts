import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SHORTS_ANALYSIS_MODEL,
  LongformOpenAIError,
  analyzeLongformCandidates,
  type LongformOpenAIClient,
  type LongformOpenAIEnvironment,
} from "./longform-openai";

const environment: LongformOpenAIEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  CLIPS_LONGFORM_ANALYSIS_MODEL: DEFAULT_SHORTS_ANALYSIS_MODEL,
  OPENAI_API_KEY: "test-openai-key",
};

const candidateWindows = [
  {
    id: "candidate-001",
    index: 0,
    start_seconds: 0,
    end_seconds: 60,
    word_count: 11,
    transcript: "A compelling opening with a complete idea.",
  },
  {
    id: "candidate-002",
    index: 1,
    start_seconds: 45,
    end_seconds: 105,
    word_count: 12,
    transcript: "An independent story beat with a useful conclusion.",
  },
];

const providerPayload = {
  version: "longform-analysis-v1",
  summary: "Two distinct, self-contained moments stand out.",
  moments: [
    {
      candidate_id: "candidate-002",
      score: 92,
      proposed_title: "The useful conclusion",
      hook: "Here is the point that changes the decision.",
      rationale: "The excerpt stands alone and reaches a clear conclusion.",
      music_mood: "focused",
      motion_direction: "Emphasize the conclusion once.",
    },
    {
      candidate_id: "candidate-001",
      score: 81,
      proposed_title: "The first principle",
      hook: "Start with this principle.",
      rationale: "The opening is clear and establishes a useful idea.",
      music_mood: "warm",
      motion_direction: "Use a gentle opening emphasis.",
    },
  ],
};

function mockClient(response: unknown): {
  client: LongformOpenAIClient;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue(response);
  return { client: { responses: { create } }, create };
}

describe("bounded OpenAI long-form analysis", () => {
  it("defaults to the supported, configured long-form analysis model", () => {
    expect(DEFAULT_SHORTS_ANALYSIS_MODEL).toBe("gpt-5.4-mini");
  });

  it("is budget gated and makes no provider request when spending is off", async () => {
    const { client, create } = mockClient({
      status: "completed",
      output_text: JSON.stringify(providerPayload),
    });
    await expect(
      analyzeLongformCandidates(
        {
          episodeDurationSeconds: 1_200,
          creatorInstructions: "",
          candidateWindows,
        },
        {
          environment: { ...environment, CLIPS_AI_BUDGET_AUTHORIZED: "false" },
          client,
        },
      ),
    ).rejects.toMatchObject({ code: "paid_ai_not_authorized" });
    expect(create).not.toHaveBeenCalled();
  });

  it("sends every bounded transcript window without storing response state", async () => {
    const { client, create } = mockClient({
      status: "completed",
      output_text: JSON.stringify(providerPayload),
    });
    const result = await analyzeLongformCandidates(
      {
        episodeDurationSeconds: 1_200,
        creatorInstructions: "Prioritize practical advice.",
        candidateWindows,
      },
      { environment, client },
    );

    expect(result.moments.map(({ candidate_id }) => candidate_id)).toEqual([
      "candidate-002",
      "candidate-001",
    ]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_SHORTS_ANALYSIS_MODEL,
        store: false,
        max_output_tokens: 8_192,
        text: expect.objectContaining({
          format: expect.objectContaining({
            type: "json_schema",
            strict: true,
          }),
        }),
      }),
    );
    const request = create.mock.calls[0]?.[0];
    expect(request?.input).toContain("candidate-001");
    expect(request?.input).toContain("candidate-002");
    expect(request?.instructions).toContain("untrusted source data");
  });

  it("rejects candidates outside the fixed catalogue and incomplete provider output", async () => {
    const invalidClient = mockClient({
      status: "completed",
      output_text: JSON.stringify({
        ...providerPayload,
        moments: [
          { ...providerPayload.moments[0], candidate_id: "candidate-999" },
        ],
      }),
    });
    await expect(
      analyzeLongformCandidates(
        {
          episodeDurationSeconds: 1_200,
          creatorInstructions: "",
          candidateWindows,
        },
        { environment, client: invalidClient.client },
      ),
    ).rejects.toMatchObject({ code: "longform_analysis_invalid_response" });

    const incompleteClient = mockClient({
      status: "incomplete",
      output_text: "",
      incomplete_details: { reason: "max_output_tokens" },
    });
    await expect(
      analyzeLongformCandidates(
        {
          episodeDurationSeconds: 1_200,
          creatorInstructions: "",
          candidateWindows,
        },
        { environment, client: incompleteClient.client },
      ),
    ).rejects.toMatchObject({
      code: "longform_analysis_provider_failed",
    });
  });

  it("rejects excessive candidate catalogues before making the call", async () => {
    const { client, create } = mockClient({
      status: "completed",
      output_text: JSON.stringify(providerPayload),
    });
    await expect(
      analyzeLongformCandidates(
        {
          episodeDurationSeconds: 7_200,
          creatorInstructions: "",
          candidateWindows: Array.from({ length: 161 }, (_, index) => ({
            ...candidateWindows[0]!,
            id: `candidate-${String(index + 1).padStart(3, "0")}`,
            index,
          })),
        },
        { environment, client },
      ),
    ).rejects.toBeInstanceOf(LongformOpenAIError);
    expect(create).not.toHaveBeenCalled();
  });
});
