import { describe, expect, it } from "vitest";
import {
  FFMPEG_SINGLE_CORE_FILTER_ARGS,
  FFMPEG_SINGLE_CORE_X264_ARGS,
} from "./ffmpeg-timeout";

describe("FFmpeg Railway resource guard", () => {
  it("pins both filtergraph and x264 pools to one worker", () => {
    expect(FFMPEG_SINGLE_CORE_FILTER_ARGS).toEqual([
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
    ]);
    expect(FFMPEG_SINGLE_CORE_X264_ARGS).toEqual([
      "-threads",
      "1",
      "-x264-params",
      "threads=1:lookahead_threads=1:sync-lookahead=0",
    ]);
  });
});
