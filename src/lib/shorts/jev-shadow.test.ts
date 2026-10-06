import { describe, expect, it, vi } from "vitest";

import {
  JEV_SHADOW_MODEL,
  JEV_SHADOW_BATCH_SIZE,
  TYPESAFE_SYSTEM_ONE_URL,
  resolveJevShadowConfig,
  runJevShadowRanking,
  runJevShadowRankingWithConsent,
  type JevShadowCandidateInput,
  type JevShadowEnvironment,
} from "./jev-shadow";

const enabledEnvironment: JevShadowEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  CLIPS_JEV_HOOK_SCORE: "shadow",
  TYPESAFE_API_KEY: "test-typesafe-key",
};

function candidate(
  id: string,
  overrides: Partial<JevShadowCandidateInput> = {},
): JevShadowCandidateInput {
  return {
    id,
    startSeconds: 45,
    endSeconds: 105,
    transcript: "This is a clear and useful example of how the idea works.",
    ...overrides,
  };
}

function scoreResponseFor(
  request: Record<string, unknown>,
  scoreOverrides: Readonly<Record<string, number>> = {},
): Response {
  const questions = request.questions as Record<string, unknown>;
  const answers = Object.fromEntries(
    Object.keys(questions).map((id) => {
      const score = scoreOverrides[id] ?? (id.endsWith("__hook") ? 3 : 2);
      return [
        id,
        {
          type: "score",
          score,
          confidence: 1,
          legend: {
            "0": "Weak",
            "1": "Ordinary",
            "2": "Good",
            "3": "Strong",
          },
          probabilities: {
            "0": score === 0 ? 1 : 0,
            "1": score === 1 ? 1 : 0,
            "2": score === 2 ? 1 : 0,
            "3": score === 3 ? 1 : 0,
          },
        },
      ];
    }),
  );
  return Response.json({
    model: JEV_SHADOW_MODEL,
    answers,
    usage: { input_tokens: 120, output_tokens: 24 },
  });
}

describe("Jev shadow ranking", () => {
  it("is opt-in behind the paid-budget gate and server-only key", () => {
    expect(resolveJevShadowConfig({})).toBeNull();
    expect(
      resolveJevShadowConfig({
        ...enabledEnvironment,
        CLIPS_AI_BUDGET_AUTHORIZED: "false",
      }),
    ).toBeNull();
    expect(
      resolveJevShadowConfig({
        ...enabledEnvironment,
        CLIPS_JEV_HOOK_SCORE: "active",
      }),
    ).toBeNull();
    expect(
      resolveJevShadowConfig({
        ...enabledEnvironment,
        NEXT_PUBLIC_TYPESAFE_API_KEY: "leaked-key",
      }),
    ).toBeNull();
    expect(resolveJevShadowConfig(enabledEnvironment)).toEqual({
      apiKey: "test-typesafe-key",
      model: JEV_SHADOW_MODEL,
    });
  });

  it("does not call Jev while disabled", async () => {
    const fetch = vi.fn();
    const result = await runJevShadowRanking(
      { candidates: [candidate("candidate-001")] },
      { environment: {}, fetch },
    );
    expect(result.status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not share transcript excerpts without project-level consent, even when Jev is configured", async () => {
    const fetch = vi.fn();
    const ranker = vi.fn(runJevShadowRanking);
    const result = await runJevShadowRankingWithConsent(
      {
        creatorInstructions:
          "Keep the sensitive details in this episode private.",
        candidates: [candidate("candidate-001")],
      },
      false,
      { environment: enabledEnvironment, fetch },
      ranker,
    );

    expect(result.status).toBe("disabled");
    expect(ranker).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends bounded typed score questions and returns a shadow-only ranking", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe(TYPESAFE_SYSTEM_ONE_URL);
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-typesafe-key",
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.model).toBe(JEV_SHADOW_MODEL);
        const state = body.state as {
          creator_instructions: string;
          candidates: Array<{ id: string; transcript_excerpt: string }>;
        };
        expect(state.creator_instructions).toBe(
          "Focus on useful beginner advice.",
        );
        expect(state.candidates[0]?.id).toBe("candidate-001");
        expect(state.candidates[0]?.transcript_excerpt).toContain(
          "clear and useful",
        );
        const questions = body.questions as Record<
          string,
          { instructions: { question: string; context: string } }
        >;
        expect(Object.keys(questions)).toHaveLength(4);
        expect(
          questions["candidate-001__instruction_fit"]?.instructions.question,
        ).toContain("creator's stated topic");
        expect(
          questions["candidate-001__instruction_fit"]?.instructions.context,
        ).toContain("state.creator_instructions");
        return scoreResponseFor(body);
      },
    );

    const result = await runJevShadowRanking(
      {
        creatorInstructions: "  Focus on useful beginner advice.  ",
        candidates: [candidate("candidate-001", { baselineRank: 7 })],
      },
      { environment: enabledEnvironment, fetch },
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("shadow_complete");
    if (result.status !== "shadow_complete")
      throw new Error("unexpected result");
    expect(result.model).toBe(JEV_SHADOW_MODEL);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      candidateId: "candidate-001",
      baselineRank: 7,
      shadowRank: 1,
      compositeScore: 78,
      confidence: 1,
    });
    expect(result.inputTokens).toBe(120);
  });

  it("uses creator instructions as an explicit shadow-ranking dimension", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return scoreResponseFor(body, {
          "candidate-001__instruction_fit": 0,
          "candidate-002__instruction_fit": 3,
        });
      },
    );

    const result = await runJevShadowRanking(
      {
        creatorInstructions: "Give beginner creators a practical writing tip.",
        candidates: [
          candidate("candidate-001", { baselineRank: 1 }),
          candidate("candidate-002", { baselineRank: 2 }),
        ],
      },
      { environment: enabledEnvironment, fetch },
    );

    expect(result.status).toBe("shadow_complete");
    if (result.status !== "shadow_complete")
      throw new Error("unexpected result");
    expect(result.results.map(({ candidateId }) => candidateId)).toEqual([
      "candidate-002",
      "candidate-001",
    ]);
    expect(result.results.map(({ compositeScore }) => compositeScore)).toEqual([
      85, 65,
    ]);
  });

  it("splits long candidate lists into bounded provider requests", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const questions = body.questions as Record<string, unknown>;
        expect(Object.keys(questions).length).toBeLessThanOrEqual(
          JEV_SHADOW_BATCH_SIZE * 4,
        );
        return scoreResponseFor(body);
      },
    );
    const candidates = Array.from(
      { length: JEV_SHADOW_BATCH_SIZE + 1 },
      (_, index) =>
        candidate(`candidate-${String(index + 1).padStart(3, "0")}`),
    );

    const result = await runJevShadowRanking(
      { candidates },
      { environment: enabledEnvironment, fetch },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("shadow_complete");
    if (result.status !== "shadow_complete")
      throw new Error("unexpected result");
    expect(result.results).toHaveLength(JEV_SHADOW_BATCH_SIZE + 1);
    expect(result.inputTokens).toBe(240);
  });

  it("retries one 429/529 with bounded backoff", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn<
        (_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>
      >()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return scoreResponseFor(body);
      });

    const result = await runJevShadowRanking(
      { candidates: [candidate("candidate-001")] },
      { environment: enabledEnvironment, fetch, sleep },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(result.status).toBe("shadow_complete");
  });

  it("does not expose provider error details or affect the fallback path", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: "private provider diagnostics and source text" },
        { status: 503 },
      ),
    );
    const result = await runJevShadowRanking(
      { candidates: [candidate("candidate-001")] },
      { environment: enabledEnvironment, fetch },
    );
    expect(result).toEqual({
      status: "shadow_failed",
      model: JEV_SHADOW_MODEL,
      results: [],
      inputTokens: null,
      outputTokens: null,
      errorCode: "typesafe_provider_failed",
    });
  });

  it("rejects a provider Score answer missing the documented legend and probabilities", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        const questions = request.questions as Record<string, unknown>;
        return Response.json({
          model: JEV_SHADOW_MODEL,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "score", score: 2, confidence: 0.8 },
            ]),
          ),
          usage: { input_tokens: 120, output_tokens: 24 },
        });
      },
    );

    const result = await runJevShadowRanking(
      { candidates: [candidate("candidate-001")] },
      { environment: enabledEnvironment, fetch },
    );

    expect(result).toEqual({
      status: "shadow_failed",
      model: JEV_SHADOW_MODEL,
      results: [],
      inputTokens: null,
      outputTokens: null,
      errorCode: "typesafe_invalid_response",
    });
  });

  it("accepts a provider Score answer at the rounded probability-weighted boundary", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        const response = (await scoreResponseFor(request).json()) as {
          answers: Record<string, Record<string, unknown>>;
        };
        response.answers["candidate-001__standalone"] = {
          type: "score",
          score: 2.36,
          confidence: 0.36,
          legend: {
            "0": "Weak",
            "1": "Ordinary",
            "2": "Good",
            "3": "Strong",
          },
          probabilities: { "0": 0, "1": 0.06, "2": 0.5, "3": 0.44 },
        };
        return Response.json(response);
      },
    );

    const result = await runJevShadowRanking(
      { candidates: [candidate("candidate-001")] },
      { environment: enabledEnvironment, fetch },
    );

    expect(result.status).toBe("shadow_complete");
  });

  it("rejects a provider Score answer beyond the rounded probability-weighted boundary", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        const response = (await scoreResponseFor(request).json()) as {
          answers: Record<string, Record<string, unknown>>;
        };
        response.answers["candidate-001__standalone"] = {
          type: "score",
          score: 2.359,
          confidence: 0.36,
          legend: {
            "0": "Weak",
            "1": "Ordinary",
            "2": "Good",
            "3": "Strong",
          },
          probabilities: { "0": 0, "1": 0.06, "2": 0.5, "3": 0.44 },
        };
        return Response.json(response);
      },
    );

    const result = await runJevShadowRanking(
      { candidates: [candidate("candidate-001")] },
      { environment: enabledEnvironment, fetch },
    );

    expect(result).toMatchObject({
      status: "shadow_failed",
      errorCode: "typesafe_invalid_response",
    });
  });

  it("rejects duplicate ids and returns a safe failure result", async () => {
    const fetch = vi.fn();
    const result = await runJevShadowRanking(
      {
        candidates: [candidate("candidate-001"), candidate("candidate-001")],
      },
      { environment: enabledEnvironment, fetch },
    );
    expect(result.status).toBe("shadow_failed");
    expect(fetch).not.toHaveBeenCalled();
  });
});
