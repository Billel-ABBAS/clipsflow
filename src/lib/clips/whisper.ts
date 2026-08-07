// ============================================================================
// ClipsFlow Clips — Whisper transcription helper (Groq + OpenAI dual-provider)
// ============================================================================
// Transcribes a video or audio URL with word-level timestamps via the
// Whisper API. Used by the clip transcription pipeline.
//
// Provider routing :
//   - Default → Groq Whisper Large v3 Turbo when GROQ_API_KEY is set
//     (216× real-time, 9× cheaper, drop-in OpenAI-compatible API).
//   - Fallback → OpenAI whisper-1 when GROQ_API_KEY is not configured.
//   - Opt-out from Groq via CLIPS_FORCE_OPENAI_WHISPER=1 if Groq
//     ever causes downstream regressions.
//
// Both paths support `response_format: "verbose_json"` +
// `timestamp_granularities: ["word"]` for word-level timing.
//
// Auto-detect mode : `language` param is intentionally omitted from the
// Whisper API call so Whisper auto-detects the source language.
//
// Dependency injection : `transcriberFactory` lets tests pass a mock client
// without monkey-patching the module cache.
//
// Ported from VidiaFlow src/lib/clipflow/whisper.ts.
// Adaptation : CLIPFLOW_FORCE_OPENAI_WHISPER → CLIPS_FORCE_OPENAI_WHISPER.
// ============================================================================

import OpenAI from "openai";
import { openAsBlob } from "node:fs";
import { safeFetch } from "@/lib/utils/safe-fetch";

export type WordTimestamp = { text: string; start: number; end: number };

export interface TranscriptionResult {
  words: WordTimestamp[];
  /** Whisper-returned language name, e.g. "english", "french". "unknown" if absent. */
  detectedLanguage: string;
  /** Resolved provider model name ("whisper-large-v3-turbo" Groq or "whisper-1" OpenAI). */
  model: string;
  /** Wall-clock latency of the transcriptions.create() call, milliseconds. */
  latencyMs: number;
}

export interface TranscriberClient {
  audio: {
    transcriptions: {
      create: (params: {
        file: File;
        model: string;
        response_format: "verbose_json";
        timestamp_granularities: ["word"];
      }) => Promise<{
        words?: { word: string; start: number; end: number }[];
        language?: string;
      }>;
    };
  };
}

/**
 * Resolves the transcriber client + model name based on env config.
 * Default = Groq Whisper Large v3 Turbo when GROQ_API_KEY is set.
 * Fallback = OpenAI whisper-1 when GROQ_API_KEY is unset, OR when
 * CLIPS_FORCE_OPENAI_WHISPER=1 is explicitly set.
 */
function defaultTranscriberConfig(): {
  client: TranscriberClient;
  model: string;
} {
  const forceOpenAI = process.env.CLIPS_FORCE_OPENAI_WHISPER === "1";
  const groqKey = process.env.GROQ_API_KEY;
  if (!forceOpenAI && groqKey) {
    return {
      client: new OpenAI({
        apiKey: groqKey,
        baseURL: "https://api.groq.com/openai/v1",
      }) as unknown as TranscriberClient,
      model: "whisper-large-v3-turbo",
    };
  }
  return {
    client: new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
    }) as unknown as TranscriberClient,
    model: "whisper-1",
  };
}

/**
 * Backward-compatible export — returns just the client (no model). Kept
 * for any caller/test that still imports `defaultTranscriber` directly.
 */
function defaultTranscriber(): TranscriberClient {
  return defaultTranscriberConfig().client;
}

// Silence unused-symbol warning : kept for backward compat with tests.
void defaultTranscriber;

/**
 * Transcribe a video or audio file at the given HTTPS URL via Whisper with
 * word-level timestamps. Routes to Groq Whisper Large v3 Turbo when
 * GROQ_API_KEY is set in env, otherwise falls back to OpenAI whisper-1.
 * Language is auto-detected by Whisper (no forced `language` param).
 *
 * @param videoUrl      Signed HTTPS URL pointing to the source file. Used
 *                      for the fetch path when `sourceBuffer` is omitted.
 * @param client        Optional injected client (test path). Defaults to
 *                      provider-aware client.
 * @param sourceBuffer  Optional pre-fetched source bytes. When provided,
 *                      the function skips the network fetch. `videoUrl` is
 *                      still required for logs.
 * @param sourcePath    Optional pre-downloaded file path on disk. When
 *                      provided, reads via `fs.openAsBlob` (no RAM load).
 *                      Takes precedence over `sourceBuffer` when both supplied.
 * @returns         Words with start/end times in seconds + Whisper-detected language.
 * @throws          If the download fails or Whisper returns an error.
 */
export async function transcribeWithWhisper(
  videoUrl: string,
  client?: TranscriberClient,
  sourceBuffer?: Buffer,
  sourcePath?: string,
): Promise<TranscriptionResult> {
  let file: File;
  if (sourcePath) {
    // File-backed Blob — Node 20+ openAsBlob streams from disk when the
    // Blob bytes are read by the consumer. No RAM load of the source.
    const blob = await openAsBlob(sourcePath, { type: "video/mp4" });
    file = new File([blob], "source.mp4", { type: "video/mp4" });
  } else {
    let buf: Buffer;
    if (sourceBuffer) {
      buf = sourceBuffer;
    } else {
      const res = await safeFetch(videoUrl, { timeoutMs: 30_000 });
      if (!res.ok) {
        throw new Error(
          `Failed to download source file: HTTP ${res.status} ${res.statusText}`,
        );
      }
      buf = Buffer.from(await res.arrayBuffer());
    }
    file = new File([new Uint8Array(buf)], "source.mp4", { type: "video/mp4" });
  }

  // When the test injects a custom client, keep model="whisper-1" so
  // existing mock contracts don't break. Production path uses provider-aware
  // config.
  let transcriber: TranscriberClient;
  let model: string;
  if (client) {
    transcriber = client;
    model = "whisper-1";
  } else {
    const config = defaultTranscriberConfig();
    transcriber = config.client;
    model = config.model;
  }

  const t0 = Date.now();
  const transcription = await transcriber.audio.transcriptions.create({
    file,
    model,
    // language: intentionally omitted → Whisper auto-detects source language
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });
  const latencyMs = Date.now() - t0;

  const words = (transcription.words ?? []).map((w) => ({
    text: w.word.trim(),
    start: w.start,
    end: w.end,
  }));

  return {
    words,
    detectedLanguage: transcription.language ?? "unknown",
    model,
    latencyMs,
  };
}
