import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import ffmpegPath from "@ffmpeg-installer/ffmpeg";

import { assertLongformEpisodeDuration } from "../src/lib/clips/longform-analysis";
import {
  buildLongformAudioChunkRanges,
  extractCandidateVisualFrames,
  extractLongformAudioChunk,
  probeLongformMedia,
} from "../src/lib/shorts/analysis-media";

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath.path, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label}: synthetic media generation timed out`));
    }, 5 * 60_000);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${label}: ffmpeg exited ${code}: ${stderr}`));
    });
  });
}

function assertDuration(
  durationSeconds: number,
  minimumSeconds: number,
  maximumSeconds: number,
  label: string,
): void {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < minimumSeconds ||
    durationSeconds > maximumSeconds
  ) {
    throw new Error(`${label}: unexpected probed duration ${durationSeconds}s`);
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "clipsflow-shorts-media-"));
  const fourHourAudio = join(directory, "synthetic-four-hour-audio.m4a");
  const fourHourVideo = join(directory, "synthetic-four-hour-video.mp4");
  let lastAudioChunk: string | null = null;

  try {
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000:duration=14400",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "16k",
        "-y",
        fourHourAudio,
      ],
      "four-hour audio",
    );

    const audioProbe = await probeLongformMedia(fourHourAudio);
    assertDuration(
      audioProbe.durationSeconds,
      14_399,
      14_400.5,
      "four-hour audio",
    );
    if (
      assertLongformEpisodeDuration(Math.round(audioProbe.durationSeconds)) !==
      14_400
    ) {
      throw new Error(
        "four-hour audio: rounded duration was not accepted at the limit",
      );
    }
    if (audioProbe.hasVideo) {
      throw new Error("four-hour audio: unexpected video stream");
    }

    const chunks = buildLongformAudioChunkRanges(audioProbe.durationSeconds);
    const lastChunk = chunks.at(-1);
    if (
      chunks.length < 12 ||
      chunks[0]?.start_seconds !== 0 ||
      !lastChunk ||
      lastChunk.end_seconds < 14_399 ||
      lastChunk.end_seconds > 14_400.5
    ) {
      throw new Error(
        "four-hour audio: chunk plan does not cover the full source",
      );
    }

    lastAudioChunk = await extractLongformAudioChunk(
      fourHourAudio,
      lastChunk.start_seconds,
      lastChunk.end_seconds,
      "local-four-hour-smoke",
    );
    if ((await stat(lastAudioChunk)).size < 1) {
      throw new Error("four-hour audio: final transcription chunk is empty");
    }

    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x90:r=1:d=14400",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:sample_rate=16000:duration=14400",
        "-shortest",
        "-c:v",
        "mpeg4",
        "-q:v",
        "30",
        "-r",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "16k",
        "-y",
        fourHourVideo,
      ],
      "four-hour audio-video",
    );

    const videoProbe = await probeLongformMedia(fourHourVideo);
    assertDuration(
      videoProbe.durationSeconds,
      14_399,
      14_400.5,
      "four-hour video",
    );
    if (
      assertLongformEpisodeDuration(Math.round(videoProbe.durationSeconds)) !==
      14_400
    ) {
      throw new Error(
        "four-hour video: rounded duration was not accepted at the limit",
      );
    }
    if (!videoProbe.hasVideo) {
      throw new Error("four-hour video: video stream was not detected");
    }

    const visualFrames = await extractCandidateVisualFrames(fourHourVideo, [
      {
        id: "local-media-smoke",
        index: 0,
        start_seconds: 60,
        end_seconds: 75,
        word_count: 1,
        transcript: "synthetic test only",
      },
    ]);
    const frames = visualFrames[0]?.frames ?? [];
    if (
      frames.length === 0 ||
      frames.length > 8 ||
      frames.some((frame) => frame.bytes.byteLength > 400 * 1024)
    ) {
      throw new Error(
        "four-hour video: bounded visual frame extraction failed",
      );
    }

    console.log(
      `Local media smoke test passed: ${Math.round(audioProbe.durationSeconds)}s audio (${chunks.length} bounded chunks; tail chunk extracted) and ${Math.round(videoProbe.durationSeconds)}s audio-video (${frames.length} bounded JPEG frames). No AI provider was called.`,
    );
  } finally {
    if (lastAudioChunk) await unlink(lastAudioChunk).catch(() => undefined);
    const tempRoot = resolve(tmpdir()) + sep;
    const target = resolve(directory);
    const relativeTarget = relative(tempRoot, target);
    if (!relativeTarget || relativeTarget.startsWith("..")) {
      throw new Error(
        "Refusing to remove media smoke files outside the temp directory",
      );
    }
    await rm(target, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown local media smoke error";
  console.error(`Local Shorts media smoke test failed: ${message}`);
  process.exitCode = 1;
});
