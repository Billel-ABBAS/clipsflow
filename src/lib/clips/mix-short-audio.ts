import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ffmpegPath from "@ffmpeg-installer/ffmpeg";

import {
  FFMPEG_SINGLE_CORE_FILTER_ARGS,
  attachFfmpegTimeout,
} from "./ffmpeg-timeout";

export type ShortSoundEffect = Readonly<{
  bytes: Uint8Array;
  atSeconds: number;
}>;

export function buildShortAudioMixArgs(input: {
  videoPath: string;
  musicPath: string;
  outputPath: string;
  durationSeconds: number;
  soundEffectPath?: string;
  soundEffectAtSeconds?: number;
}): string[] {
  if (
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    !input.videoPath ||
    !input.musicPath ||
    !input.outputPath
  ) {
    throw new Error("short_audio_mix_input_invalid");
  }
  const hasEffect = Boolean(input.soundEffectPath);
  const effectOffset = input.soundEffectAtSeconds ?? 0;
  if (
    hasEffect &&
    (!Number.isFinite(effectOffset) ||
      effectOffset < 0 ||
      effectOffset >= input.durationSeconds)
  ) {
    throw new Error("short_audio_effect_offset_invalid");
  }

  const filter = [
    "[1:a]volume=0.16[music]",
    "[music][0:a]sidechaincompress=threshold=0.025:ratio=8:attack=18:release=420[ducked]",
  ];
  // The packaged FFmpeg build predates amix=normalize=0. Restore the sum
  // after amix's default input-count normalization, then cap peaks safely.
  if (hasEffect) {
    const delayMs = Math.round(effectOffset * 1_000);
    const effectTargetSamples = Math.ceil(input.durationSeconds * 48_000);
    filter.push(
      `[2:a]volume=0.45,adelay=${delayMs}:all=1,aresample=48000,apad=whole_len=${effectTargetSamples}[effect]`,
    );
    filter.push(
      "[0:a][ducked][effect]amix=inputs=3:duration=first:dropout_transition=2,volume=3,alimiter=limit=0.95[audio]",
    );
  } else {
    filter.push(
      "[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=2,volume=2,alimiter=limit=0.95[audio]",
    );
  }

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...FFMPEG_SINGLE_CORE_FILTER_ARGS,
    "-i",
    input.videoPath,
    "-stream_loop",
    "-1",
    "-i",
    input.musicPath,
    ...(hasEffect ? ["-i", input.soundEffectPath!] : []),
    "-filter_complex",
    filter.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[audio]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    input.durationSeconds.toFixed(3),
    "-map_metadata",
    "0",
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}

/** Mix an instrumental bed under source speech and optionally add one accent. */
export async function mixShortAudio(
  video: Buffer,
  music: Uint8Array,
  durationSeconds: number,
  soundEffect?: ShortSoundEffect,
): Promise<Buffer> {
  if (video.byteLength === 0 || music.byteLength === 0) {
    throw new Error("short_audio_mix_input_empty");
  }
  const workDir = await mkdtemp(join(tmpdir(), "clipsflow-shorts-audio-"));
  const videoPath = join(workDir, "video.mp4");
  const musicPath = join(workDir, "music.mp3");
  const outputPath = join(workDir, `mixed-${randomUUID()}.mp4`);
  const soundEffectPath = soundEffect ? join(workDir, "effect.mp3") : undefined;
  try {
    await Promise.all([
      writeFile(videoPath, video),
      writeFile(musicPath, Buffer.from(music)),
      ...(soundEffect && soundEffectPath
        ? [writeFile(soundEffectPath, Buffer.from(soundEffect.bytes))]
        : []),
    ]);

    const child = spawn(
      ffmpegPath.path,
      buildShortAudioMixArgs({
        videoPath,
        musicPath,
        outputPath,
        durationSeconds,
        ...(soundEffectPath
          ? {
              soundEffectPath,
              soundEffectAtSeconds: soundEffect?.atSeconds,
            }
          : {}),
      }),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4_000);
    });
    const watchdog = attachFfmpegTimeout(child, "shorts_audio_mix");
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          if (watchdog.timedOut()) reject(new Error(watchdog.message()));
          else if (code === 0) resolve();
          else {
            const diagnostics = stderrTail
              .replaceAll(workDir, "<temp>")
              .trim()
              .split(/\r?\n/u)
              .filter(Boolean)
              .slice(-8)
              .join(" | ")
              .slice(0, 1_000);
            reject(
              new Error(
                `shorts_audio_mix_failed:${code ?? "signal"}${diagnostics ? `: ${diagnostics}` : ""}`,
              ),
            );
          }
        });
      });
    } finally {
      watchdog.clear();
    }
    const output = await readFile(outputPath);
    if (output.byteLength === 0)
      throw new Error("shorts_audio_mix_empty_output");
    return output;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
