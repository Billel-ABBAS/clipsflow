import { afterEach, describe, expect, it, vi } from "vitest";

import { createShortsAnalysisStorageClient } from "@/lib/supabase/admin";
import {
  buildLongformAudioChunkRanges,
  resolveLongformSourceUrl,
} from "./analysis-media";

const mocks = vi.hoisted(() => ({
  createShortsAnalysisStorageClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => mocks);

const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

afterEach(() => {
  vi.clearAllMocks();
  if (previousSupabaseUrl === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
  }
});

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

  it("covers a four-hour source without gaps while keeping every provider chunk bounded", () => {
    const durationSeconds = 4 * 60 * 60;
    const ranges = buildLongformAudioChunkRanges(durationSeconds);

    expect(ranges).toHaveLength(26);
    expect(ranges[0]).toMatchObject({
      index: 0,
      start_seconds: 0,
      skip_leading_seconds: 0,
    });
    expect(ranges.at(-1)?.end_seconds).toBe(durationSeconds);

    for (const [index, range] of ranges.entries()) {
      expect(range.end_seconds - range.start_seconds).toBeLessThanOrEqual(600);
      expect(range.skip_leading_seconds).toBe(index === 0 ? 0 : 30);

      if (index > 0) {
        const previous = ranges[index - 1]!;
        expect(range.start_seconds).toBe(previous.end_seconds - 30);
        expect(range.start_seconds + range.skip_leading_seconds).toBe(
          previous.end_seconds,
        );
      }
    }
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

describe("long-form source URL resolution", () => {
  it("signs private source objects with the isolated analysis storage client", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://clipsflow-test.supabase.co";
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: {
        signedUrl:
          "https://clipsflow-test.supabase.co/storage/v1/object/sign/clip-sources/source-token",
      },
      error: null,
    });
    const from = vi.fn(() => ({ createSignedUrl }));
    mocks.createShortsAnalysisStorageClient.mockReturnValue({
      storage: { from },
    });

    await expect(
      resolveLongformSourceUrl({
        id: "episode-id",
        user_id: "user-id",
        source_type: "upload",
        source_url: null,
        source_storage_path: "user-id/shorts/source.mp4",
        status: "ready",
      }),
    ).resolves.toEqual({
      url: "https://clipsflow-test.supabase.co/storage/v1/object/sign/clip-sources/source-token",
      allowedHosts: ["clipsflow-test.supabase.co"],
    });

    expect(createShortsAnalysisStorageClient).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("clip-sources");
    expect(createSignedUrl).toHaveBeenCalledWith(
      "user-id/shorts/source.mp4",
      6 * 60 * 60,
    );
  });
});
