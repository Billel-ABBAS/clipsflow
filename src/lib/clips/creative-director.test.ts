import { describe, expect, it, vi } from "vitest";

import {
  CREATIVE_DIRECTOR_OUTPUT_JSON_SCHEMA,
  CREATIVE_DIRECTOR_RESPONSE_VERSION,
  CreativeDirectorError,
  creativeDirectorInputHash,
  createCreativeDirection,
  normalizeCreativeDirectorInput,
  parseCreativeDirectorResult,
  type CreativeDirectorEnvironment,
  type CreativeDirectorFetch,
} from "./creative-director";
import { CLAUDE_OPUS_5_5_MODEL_API_ID } from "./creative-director-model";

const enabledEnvironment: CreativeDirectorEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  CLIPS_CREATIVE_DIRECTOR_ENABLED: "true",
  ANTHROPIC_API_KEY: "test-anthropic-key",
};

const selectedShort = {
  candidateId: "candidate_01",
  startSeconds: 31,
  endSeconds: 91,
  transcript: "A useful selected passage with a complete point.",
  userInstructions: "Keep it clear and restrained.",
};

const validDirection = {
  version: CREATIVE_DIRECTOR_RESPONSE_VERSION,
  title: "One clear idea",
  hook: "Here is the key idea.",
  rationale: "The selected passage is self-contained.",
  music: {
    mood: "focused",
    energy: "medium",
    instrumental_prompt: "Warm, minimal instrumental bed with a gentle pulse.",
  },
  motion: {
    template: "editorial-focus",
    intensity: "subtle",
    beat_sheet: [
      {
        at_seconds: 8,
        action: "caption-emphasis",
        detail: "Emphasize the key phrase.",
      },
    ],
  },
};

describe("Claude Opus 5.5 creative direction", () => {
  it("normalizes the selected short and bounds its duration", () => {
    expect(
      normalizeCreativeDirectorInput({
        ...selectedShort,
        transcript: "  A useful\nselected passage.  ",
      }),
    ).toMatchObject({
      candidateId: "candidate_01",
      startSeconds: 31,
      endSeconds: 91,
      durationSeconds: 60,
      transcript: "A useful selected passage.",
    });
    expect(() =>
      normalizeCreativeDirectorInput({
        ...selectedShort,
        endSeconds: 212,
      }),
    ).toThrowError(CreativeDirectorError);
  });

  it("does not call Anthropic unless both paid-AI and creative flags are enabled", async () => {
    const fetch = vi.fn();
    await expect(
      createCreativeDirection(selectedShort, { environment: {}, fetch }),
    ).rejects.toMatchObject({ code: "paid_ai_not_authorized" });
    await expect(
      createCreativeDirection(selectedShort, {
        environment: {
          ...enabledEnvironment,
          CLIPS_AI_BUDGET_AUTHORIZED: "false",
        },
        fetch,
      }),
    ).rejects.toMatchObject({ code: "paid_ai_not_authorized" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls Anthropic only with the documented Opus 5.5 ID after both gates pass", async () => {
    const fetch = vi.fn<CreativeDirectorFetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(validDirection) }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await createCreativeDirection(selectedShort, {
      environment: {
        ...enabledEnvironment,
        CLIPS_CREATIVE_DIRECTOR_MODEL: CLAUDE_OPUS_5_5_MODEL_API_ID,
      },
      fetch,
    });

    expect(result).toEqual(validDirection);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: CLAUDE_OPUS_5_5_MODEL_API_ID,
      max_tokens: 1_200,
      output_config: { format: { type: "json_schema" } },
    });
  });

  it("sends a raw JSON schema without unsupported string, number, or array constraints", () => {
    expect(JSON.stringify(CREATIVE_DIRECTOR_OUTPUT_JSON_SCHEMA)).not.toMatch(
      /"(?:minLength|maxLength|minimum|maximum|maxItems)"/u,
    );
  });

  it("does not substitute Opus 5 when a different model ID is configured", async () => {
    const fetch = vi.fn();
    await expect(
      createCreativeDirection(selectedShort, {
        environment: {
          ...enabledEnvironment,
          CLIPS_CREATIVE_DIRECTOR_MODEL: "claude-opus-5",
        },
        fetch,
      }),
    ).rejects.toMatchObject({
      code: "creative_director_unavailable",
      message: "creative_director_model_configuration_rejected",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps calls behind Anthropic's paid budget and feature gates", async () => {
    const fetch = vi.fn();
    await expect(
      createCreativeDirection(selectedShort, {
        environment: {
          ...enabledEnvironment,
          CLIPS_CREATIVE_DIRECTOR_ENABLED: "false",
        },
        fetch,
      }),
    ).rejects.toMatchObject({ code: "creative_director_disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hashes normalized selected-short input deterministically", () => {
    expect(creativeDirectorInputHash(selectedShort)).toBe(
      creativeDirectorInputHash({
        ...selectedShort,
        transcript: " A useful selected passage with a complete point. ",
      }),
    );
    expect(creativeDirectorInputHash(selectedShort)).not.toBe(
      creativeDirectorInputHash({
        ...selectedShort,
        candidateId: "candidate_02",
      }),
    );
  });

  it("validates a bounded creative plan without provider access", () => {
    expect(parseCreativeDirectorResult(validDirection, 60)).toMatchObject({
      version: CREATIVE_DIRECTOR_RESPONSE_VERSION,
      title: "One clear idea",
      music: { mood: "focused", energy: "medium" },
      motion: { template: "editorial-focus", beat_sheet: [{ at_seconds: 8 }] },
    });
    expect(() =>
      parseCreativeDirectorResult(
        {
          ...validDirection,
          motion: {
            ...validDirection.motion,
            beat_sheet: [{ at_seconds: 60, action: "hold", detail: "Hold." }],
          },
        },
        60,
      ),
    ).toThrowError(CreativeDirectorError);
    expect(() =>
      parseCreativeDirectorResult(
        {
          ...validDirection,
          motion: {
            ...validDirection.motion,
            beat_sheet: Array.from({ length: 9 }, (_, index) => ({
              at_seconds: index + 1,
              action: "hold",
              detail: "Hold on the key point.",
            })),
          },
        },
        60,
      ),
    ).toThrowError(CreativeDirectorError);
  });
});
