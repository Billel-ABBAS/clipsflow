import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  hasCachedShortsAudioAsset,
  resolveShortsMotionEffect,
  resolveShortsMusicPrompt,
} from "./elevenlabs-render";

describe("Shorts ElevenLabs creative plan", () => {
  it("chooses a safe instrumental template locally without forwarding transcript text", () => {
    const prompt = resolveShortsMusicPrompt(
      "Un lancement rapide",
      "Un conseil très urgent",
      "punchy-cuts",
    );
    expect(prompt).toContain("instrumental");
    expect(prompt).not.toContain("Un lancement");
    expect(prompt).not.toContain("urgent");
    expect(prompt).not.toMatch(/\b(voice|lyrics|speech|narration)\b/iu);
  });

  it("uses an allow-listed AI music mood while keeping provider prompts fixed", () => {
    const prompt = resolveShortsMusicPrompt(
      "A neutral title",
      "A neutral hook",
      "calm-focus",
      "uplifting",
    );
    expect(prompt).toContain("uplifting instrumental");
    expect(prompt).not.toContain("neutral title");
    expect(
      resolveShortsMusicPrompt(
        "A launch story",
        "A fast conclusion",
        "punchy-cuts",
        "untrusted provider text",
      ),
    ).toContain("energetic modern instrumental");
  });

  it("places only one bounded non-verbal accent for energetic caption motion", () => {
    expect(resolveShortsMotionEffect("kinetic-captions")).toEqual({
      prompt: "Brief light digital pop accent, clean, subtle, and non-verbal.",
      atSeconds: 1.8,
      durationSeconds: 0.8,
    });
    expect(resolveShortsMotionEffect("calm-focus")).toBeNull();
  });

  it("recognizes an existing private audio object without requiring provider configuration", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValue(query);
    const list = vi.fn(
      async (_folder: string, options: { search?: string }) => ({
        data: [{ name: options.search ?? "" }],
        error: null,
      }),
    );
    const admin = {
      from: vi.fn(() => query),
      storage: { from: vi.fn(() => ({ list })) },
    } as unknown as SupabaseClient;

    await expect(
      hasCachedShortsAudioAsset(admin, {
        userId: "user-1",
        projectId: "project-1",
        candidateId: "candidate-1",
        kind: "music",
        prompt: "A fixed synthetic music prompt.",
      }),
    ).resolves.toBe(true);
    expect(list).toHaveBeenCalledWith("user-1/shorts/project-1/candidate-1", {
      limit: 100,
      search: expect.stringMatching(/^music-[0-9a-f]{64}\.mp3$/u),
    });
  });

  it("does not treat a different audio object in the folder as a cache hit", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValue(query);
    const list = vi.fn(async () => ({
      data: [{ name: "music-for-another-prompt.mp3" }],
      error: null,
    }));
    const admin = {
      from: vi.fn(() => query),
      storage: { from: vi.fn(() => ({ list })) },
    } as unknown as SupabaseClient;

    await expect(
      hasCachedShortsAudioAsset(admin, {
        userId: "user-1",
        projectId: "project-1",
        candidateId: "candidate-1",
        kind: "music",
        prompt: "A fixed synthetic music prompt.",
      }),
    ).resolves.toBe(false);
  });
});
