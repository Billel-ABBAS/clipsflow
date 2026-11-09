/** Native, self-hosted ACE-Step client. No commercial-provider fallback. */
export const OPEN_MUSIC_MODEL = "acestep-v15-turbo" as const;
export const OPEN_SFX_MODEL = "clipsflow-dsp-v1" as const;
export interface OpenAudioConfig { baseUrl: string; token: string }
export type OpenAudioEnvironment = Record<string, string | undefined>;

export function resolveOpenAudioConfig(env: OpenAudioEnvironment): OpenAudioConfig {
  if (env.CLIPS_OPEN_AUDIO_ENABLED !== "true") throw new Error("open_audio_disabled");
  if (env.CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED !== "true") throw new Error("open_audio_compute_not_authorized");
  if (env.NEXT_PUBLIC_OPEN_AUDIO_API_KEY?.trim()) throw new Error("open_audio_public_key_rejected");
  let url: URL;
  try { url = new URL(env.CLIPS_OPEN_AUDIO_BASE_URL ?? ""); } catch { throw new Error("open_audio_url_invalid"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const token = env.CLIPS_OPEN_AUDIO_API_KEY?.trim() ?? "";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      /(^|\.)elevenlabs\.(io|com)$/i.test(url.hostname) || (!loopback && token.length < 16)) {
    throw new Error("open_audio_configuration_invalid");
  }
  return { baseUrl: url.origin, token };
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || declared > maximum || !response.body) throw new Error("open_audio_response_invalid");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("open_audio_response_too_large"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error("open_audio_response_empty");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("open_audio_result_invalid");
  return value as Record<string, unknown>;
}

export async function generateAceMusic(
  request: { prompt: string; durationSeconds: number },
  config: OpenAudioConfig,
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ bytes: Uint8Array; taskId: string }> {
  if (!Number.isFinite(request.durationSeconds) || request.durationSeconds < 3 || request.durationSeconds > 180 ||
      typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 900) {
    throw new Error("open_audio_input_invalid");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(120_000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const get = (path: string, body?: unknown) => fetcher(new URL(path, config.baseUrl), {
    method: body === undefined ? "GET" : "POST", headers, signal, redirect: "error",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (path: string, body: unknown): Promise<unknown> => {
    const envelope = object(JSON.parse(new TextDecoder().decode(await readBounded(await get(path, body), 65_536))));
    if (envelope.code !== 200 || envelope.error) throw new Error("open_audio_provider_failed");
    return envelope.data;
  };
  try {
    const created = object(await json("/release_task", {
      model: OPEN_MUSIC_MODEL, prompt: request.prompt, lyrics: "[Instrumental]",
      vocal_language: "unknown", audio_duration: Math.max(10, request.durationSeconds),
      audio_format: "mp3", batch_size: 1, thinking: false,
      use_cot_caption: false, use_cot_language: false, use_format: false,
      inference_steps: 8,
    }));
    const taskId = created.task_id;
    if (typeof taskId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error("open_audio_result_invalid");
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      const data = await json("/query_result", { task_id_list: [taskId] });
      if (!Array.isArray(data)) throw new Error("open_audio_result_invalid");
      const result = object(data.find((row) => object(row).task_id === taskId));
      if (result.status === 2) throw new Error("open_audio_provider_failed");
      if (result.status === 1) {
        if (typeof result.result !== "string") throw new Error("open_audio_result_invalid");
        const files: unknown = JSON.parse(result.result);
        if (!Array.isArray(files) || files.length !== 1) throw new Error("open_audio_result_invalid");
        const file = object(files[0]).file;
        if (typeof file !== "string") throw new Error("open_audio_result_invalid");
        const url = new URL(file, config.baseUrl);
        if (url.origin !== config.baseUrl || url.username || url.password || url.hash ||
            url.pathname !== "/v1/audio" || !url.searchParams.get("path") ||
            [...url.searchParams.keys()].some((key) => key !== "path") || url.searchParams.getAll("path").length !== 1) {
          throw new Error("open_audio_result_url_invalid");
        }
        const response = await get(url.pathname + url.search);
        if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "audio/mpeg") throw new Error("open_audio_audio_invalid");
        return { bytes: await readBounded(response, 32 * 1024 * 1024), taskId };
      }
      if (result.status !== 0) throw new Error("open_audio_result_invalid");
      if (attempt < 59) await sleep(2_000);
    }
    throw new Error("open_audio_timeout");
  } catch (error) {
    if (signal.aborted) throw new Error("open_audio_timeout");
    if (error instanceof Error && /^open_audio_[a-z_]+$/.test(error.message)) throw error;
    throw new Error("open_audio_provider_failed");
  }
}
