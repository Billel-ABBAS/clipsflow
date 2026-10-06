import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENAI_SHORTS_VISUAL_MODEL,
  DEFAULT_SHORTS_VISUAL_MODEL,
  ShortsVisualAnalysisError,
  analyzeShortsVisualFrames,
  resolveShortsVisualConfig,
  type ShortsVisualEnvironment,
} from "./visual-analysis";

const environment: ShortsVisualEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  CLIPS_VISUAL_ANALYSIS_ENABLED: "true",
  CLIPS_VISUAL_ANALYSIS_MODEL: DEFAULT_SHORTS_VISUAL_MODEL,
  GEMINI_API_KEY: "test-gemini-key",
};

const input = [
  {
    candidateId: "candidate-001",
    frames: [
      { timestampSeconds: 12, bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
      { timestampSeconds: 22, bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
    ],
  },
];

function geminiResponse(summaries: unknown): Response {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify({ summaries }) }],
        },
      },
    ],
  });
}

function openAiResponse(summaries: unknown): Response {
  return Response.json({
    id: "resp_test",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ summaries }) }],
      },
    ],
  });
}

describe("selected-short visual analysis", () => {
  it("requires an explicit server-side budget, feature flag, and key", () => {
    expect(() => resolveShortsVisualConfig({})).toThrowError(
      ShortsVisualAnalysisError,
    );
    expect(() =>
      resolveShortsVisualConfig({
        ...environment,
        CLIPS_VISUAL_ANALYSIS_ENABLED: "false",
      }),
    ).toThrowError("visual_analysis_disabled");
    expect(resolveShortsVisualConfig(environment)).toEqual({
      provider: "gemini",
      apiKey: "test-gemini-key",
      model: DEFAULT_SHORTS_VISUAL_MODEL,
    });
  });

  it("automatically reuses the server-side OpenAI key when Gemini is absent", () => {
    expect(
      resolveShortsVisualConfig({
        ...environment,
        CLIPS_VISUAL_ANALYSIS_PROVIDER: "auto",
        CLIPS_VISUAL_ANALYSIS_MODEL: "",
        GEMINI_API_KEY: "",
        OPENAI_API_KEY: "test-openai-key",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "test-openai-key",
      model: DEFAULT_OPENAI_SHORTS_VISUAL_MODEL,
    });
  });

  it("sends only supplied JPEG still frames and returns exact candidate summaries", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain(
        `/models/${DEFAULT_SHORTS_VISUAL_MODEL}:generateContent`,
      );
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(
        "test-gemini-key",
      );
      const body = JSON.parse(String(init?.body)) as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
        generationConfig: { responseMimeType: string };
      };
      expect(body.generationConfig.responseMimeType).toBe("application/json");
      const images = body.contents[0]?.parts.filter(
        (part) => "inlineData" in part,
      );
      expect(images).toHaveLength(2);
      expect(body.contents[0]?.parts[0]?.text).toContain("Do not identify");
      return geminiResponse([
        {
          candidate_id: "candidate-001",
          summary: "A speaker is framed against a simple studio background.",
          visual_score: 68,
        },
      ]);
    });

    await expect(
      analyzeShortsVisualFrames(input, { environment, fetch }),
    ).resolves.toEqual([
      {
        candidateId: "candidate-001",
        summary: "A speaker is framed against a simple studio background.",
        visualScore: 68,
      },
    ]);
  });

  it("sends bounded JPEG frames to OpenAI Responses without storing the response", async () => {
    const openAiEnvironment: ShortsVisualEnvironment = {
      ...environment,
      CLIPS_VISUAL_ANALYSIS_PROVIDER: "openai",
      CLIPS_VISUAL_ANALYSIS_MODEL: DEFAULT_OPENAI_SHORTS_VISUAL_MODEL,
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: "test-openai-key",
    };
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-openai-key",
      );
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        store: boolean;
        input: Array<{ content: Array<Record<string, unknown>> }>;
        text: { format: { type: string; strict: boolean; schema: unknown } };
      };
      expect(body.model).toBe(DEFAULT_OPENAI_SHORTS_VISUAL_MODEL);
      expect(body.store).toBe(false);
      expect(body.text.format).toMatchObject({
        type: "json_schema",
        strict: true,
      });
      const images = body.input[0]?.content.filter(
        (part) => part.type === "input_image",
      );
      expect(images).toHaveLength(2);
      expect(images?.[0]).toMatchObject({
        image_url: `data:image/jpeg;base64,${Buffer.from(input[0]!.frames[0]!.bytes).toString("base64")}`,
        detail: "low",
      });
      expect(String(init?.body)).not.toContain("test-openai-key");
      return openAiResponse([
        {
          candidate_id: "candidate-001",
          summary: "A clearly framed speaker in a quiet studio.",
          visual_score: 72,
        },
      ]);
    });

    await expect(
      analyzeShortsVisualFrames(input, {
        environment: openAiEnvironment,
        fetch,
      }),
    ).resolves.toEqual([
      {
        candidateId: "candidate-001",
        summary: "A clearly framed speaker in a quiet studio.",
        visualScore: 72,
      },
    ]);
  });

  it("keeps visual API keys out of client-side environment variables", () => {
    expect(() =>
      resolveShortsVisualConfig({
        ...environment,
        NEXT_PUBLIC_OPENAI_API_KEY: "not-allowed",
      }),
    ).toThrowError("visual_analysis_unavailable");
  });

  it("rejects duplicate, missing, or invented visual candidate IDs", async () => {
    const fetch = vi.fn(async () =>
      geminiResponse([
        {
          candidate_id: "candidate-999",
          summary: "A street scene.",
          visual_score: 90,
        },
      ]),
    );
    await expect(
      analyzeShortsVisualFrames(input, { environment, fetch }),
    ).rejects.toMatchObject({ code: "visual_analysis_invalid_response" });

    await expect(
      analyzeShortsVisualFrames([input[0]!, input[0]!], { environment, fetch }),
    ).rejects.toMatchObject({ code: "visual_analysis_input_invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-range visual score instead of persisting it", async () => {
    const fetch = vi.fn(async () =>
      geminiResponse([
        {
          candidate_id: "candidate-001",
          summary: "A speaker is clearly framed.",
          visual_score: 101,
        },
      ]),
    );
    await expect(
      analyzeShortsVisualFrames(input, { environment, fetch }),
    ).rejects.toMatchObject({ code: "visual_analysis_invalid_response" });
  });

  it("does not request visual analysis when the budget is off", async () => {
    const fetch = vi.fn();
    await expect(
      analyzeShortsVisualFrames(input, {
        environment: { ...environment, CLIPS_AI_BUDGET_AUTHORIZED: "false" },
        fetch,
      }),
    ).rejects.toMatchObject({ code: "paid_ai_not_authorized" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
