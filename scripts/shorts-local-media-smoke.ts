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
  const twoHourAudio = join(directory, "synthetic-two-hour-audio.m4a");
  const twentyMinuteVideo = join(
    directory,
    "synthetic-twenty-minute-video.mp4",
  );
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
        "sine=frequency=440:sample_rate=16000:duration=7200",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "16k",
        "-y",
        twoHourAudio,
      ],
      "two-hour audio",
    );

    const audioProbe = await probeLongformMedia(twoHourAudio);
    assertDuration(
      audioProbe.durationSeconds,
      7_199,
      7_200.5,
      "two-hour audio",
    );
    if (
      assertLongformEpisodeDuration(Math.round(audioProbe.durationSeconds)) !==
      7_200
    ) {
      throw new Error(
        "two-hour audio: rounded duration was not accepted at the limit",
      );
    }
    if (audioProbe.hasVideo) {
      throw new Error("two-hour audio: unexpected video stream");
    }

    const chunks = buildLongformAudioChunkRanges(audioProbe.durationSeconds);
    const lastChunk = chunks.at(-1);
    if (
      chunks.length < 12 ||
      chunks[0]?.start_seconds !== 0 ||
      !lastChunk ||
      lastChunk.end_seconds < 7_199 ||
      lastChunk.end_seconds > 7_200.5
    ) {
      throw new Error(
        "two-hour audio: chunk plan does not cover the full source",
      );
    }

    lastAudioChunk = await extractLongformAudioChunk(
      twoHourAudio,
      lastChunk.start_seconds,
      lastChunk.end_seconds,
      "local-two-hour-smoke",
    );
    if ((await stat(lastAudioChunk)).size < 1) {
      throw new Error("two-hour audio: final transcription chunk is empty");
    }

    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x90:r=1:d=1200",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:sample_rate=16000:duration=1200",
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
        twentyMinuteVideo,
      ],
      "twenty-minute audio-video",
    );

    const videoProbe = await probeLongformMedia(twentyMinuteVideo);
    assertDuration(
      videoProbe.durationSeconds,
      1_199,
      1_200.5,
      "twenty-minute video",
    );
    if (
      assertLongformEpisodeDuration(Math.round(videoProbe.durationSeconds)) !==
      1_200
    ) {
      throw new Error(
        "twenty-minute video: rounded duration was not accepted at the limit",
      );
    }
    if (!videoProbe.hasVideo) {
      throw new Error("twenty-minute video: video stream was not detected");
    }

    const visualFrames = await extractCandidateVisualFrames(twentyMinuteVideo, [
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
        "twenty-minute video: bounded visual frame extraction failed",
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
