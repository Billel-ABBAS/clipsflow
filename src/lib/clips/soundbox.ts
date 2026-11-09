/** Soundbox local audio inference, shared by the Shorts render worker. */
export const SOUNDBOX_MUSIC_MODEL = "audiocpp-ace-step" as const;
export const SOUNDBOX_SOUND_MODEL = "audiocpp-midashenglm-gen" as const;
const MAX_MUSIC_BYTES = 32 * 1024 * 1024;
const MAX_SFX_BYTES = 8 * 1024 * 1024;

export interface SoundboxEnvironment extends Record<string, string | undefined> {
  CLIPS_SOUNDBOX_ENABLED?: string;
  CLIPS_SOUNDBOX_BASE_URL?: string;
  CLIPS_SOUNDBOX_PROXY_TOKEN?: string;
  CLIPS_SOUNDBOX_MODELS_COMMERCIAL_OK?: string;
  NEXT_PUBLIC_CLIPS_SOUNDBOX_PROXY_TOKEN?: string;
}

export interface SoundboxAuthorization {
  explicitUserConsent: boolean;
  commercialLicenseConfirmed: boolean;
}

export interface SoundboxAudioRequest {
  kind: "music" | "sound_effect";
  prompt: string;
  shortDurationSeconds: number;
  authorization: SoundboxAuthorization;
}

export interface SoundboxAudio {
  bytes: Uint8Array;
  contentType: "audio/mpeg";
  model: typeof SOUNDBOX_MUSIC_MODEL | typeof SOUNDBOX_SOUND_MODEL;
  durationSeconds: number;
}

export class SoundboxError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SoundboxError";
  }
}

export function resolveSoundboxConfig(
  env: SoundboxEnvironment = process.env,
): { baseUrl: string; proxyToken: string | null } {
  if (env.CLIPS_SOUNDBOX_ENABLED !== "true") {
    throw new SoundboxError("soundbox_disabled");
  }
  if (env.CLIPS_SOUNDBOX_MODELS_COMMERCIAL_OK !== "true") {
    throw new SoundboxError("soundbox_models_not_approved");
  }
  if (env.NEXT_PUBLIC_CLIPS_SOUNDBOX_PROXY_TOKEN?.trim()) {
    throw new SoundboxError("soundbox_public_secret_rejected");
  }
  let url: URL;
  try {
    url = new URL(env.CLIPS_SOUNDBOX_BASE_URL?.trim() ?? "");
  } catch {
    throw new SoundboxError("soundbox_url_invalid");
  }
  const localOrInternal =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (!url.hostname.includes(".") && /^[a-z0-9-]+$/iu.test(url.hostname)) ||
    url.hostname.endsWith(".internal");
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && localOrInternal)) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) throw new SoundboxError("soundbox_url_invalid");
  const token = env.CLIPS_SOUNDBOX_PROXY_TOKEN?.trim() || null;
  // Soundbox has no built-in API key: an HTTPS host MUST be a gated reverse proxy.
  if (url.protocol === "https:" && !token) {
    throw new SoundboxError("soundbox_proxy_auth_required");
  }
  return { baseUrl: url.origin, proxyToken: token };
}

function soundboxHeaders(token: string | null): HeadersInit {
  return {
    "content-type": "application/json",
    "X-Soundbox": "1",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
function jobId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/iu.test(value)) {
    throw new SoundboxError("soundbox_job_invalid");
  }
  return value;
}
function checkShortRequest(request: SoundboxAudioRequest): number {
  if (!request.authorization?.explicitUserConsent ||
      !request.authorization.commercialLicenseConfirmed) {
    throw new SoundboxError("soundbox_consent_required");
  }
  if (!Number.isFinite(request.shortDurationSeconds) ||
      request.shortDurationSeconds < 1 || request.shortDurationSeconds > 180 ||
      typeof request.prompt !== "string" || request.prompt.trim().length < 2 ||
      request.prompt.length > 600) {
    throw new SoundboxError("soundbox_input_invalid");
  }
  // ACE-Step Turbo supports <=60 s; FFmpeg loops the bed under a longer Short.
  return request.kind === "music"
    ? Math.min(60, Math.max(10, request.shortDurationSeconds))
    : Math.min(3, Math.max(0.5, request.shortDurationSeconds / 20));
}
async function readMp3(response: Response, maxBytes: number): Promise<Uint8Array> {
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mime !== "audio/mpeg" && mime !== "audio/mp3") {
    throw new SoundboxError("soundbox_audio_format_invalid");
  }
  const n = response.headers.get("content-length");
  if (n && Number(n) > maxBytes) throw new SoundboxError("soundbox_audio_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new SoundboxError("soundbox_audio_empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new SoundboxError("soundbox_audio_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) throw new SoundboxError("soundbox_audio_empty");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Submit, poll, and download a generated track from a private Soundbox worker. */
export async function generateSoundboxAudio(
  request: SoundboxAudioRequest,
  options: {
    environment?: SoundboxEnvironment;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    maxPolls?: number;
  } = {},
): Promise<SoundboxAudio> {
  const durationSeconds = checkShortRequest(request);
  const config = resolveSoundboxConfig(options.environment);
  const model = request.kind === "music" ? SOUNDBOX_MUSIC_MODEL : SOUNDBOX_SOUND_MODEL;
  const fetcher = options.fetch ?? fetch;
  const headers = soundboxHeaders(config.proxyToken);
  const requestJson = async (
    url: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetcher(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    } catch { throw new SoundboxError("soundbox_unreachable"); }
    if (!res.ok) throw new SoundboxError("soundbox_provider_failed");
    try {
      const value: unknown = await res.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SoundboxError("soundbox_response_invalid");
      }
      return value as Record<string, unknown>;
    } catch {
      throw new SoundboxError("soundbox_response_invalid");
    }
  };
  const started = await requestJson(`${config.baseUrl}/api/generate`, {
    method: "POST",
    body: JSON.stringify({
      model,
      prompt: request.kind === "music"
        ? `Instrumental only. No vocals, speech, lyrics, or imitation of real artists. ${request.prompt}`
        : `Non-verbal sound effect, no speech or music. ${request.prompt}`,
      duration_s: durationSeconds,
      variations: 1,
      ...(request.kind === "music" ? { lyrics: "" } : {}),
    }),
  });
  const id = jobId(started?.job_id);
  const wait = options.sleep ?? ((ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let soundId: string | null = null;
  const maxPolls = Math.max(1, Math.min(240, options.maxPolls ?? 240));
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const job = await requestJson(`${config.baseUrl}/api/jobs/${id}`);
    if (job?.status === "error" || job?.status === "cancelled") {
      throw new SoundboxError("soundbox_generation_failed");
    }
    if (job?.status === "done") {
      const result = job.result;
      const sounds =
        result && typeof result === "object" && !Array.isArray(result) &&
        "sounds" in result
          ? result.sounds
          : null;
      soundId = jobId(Array.isArray(sounds) ? sounds[0] : null);
      break;
    }
    if (job?.status !== "queued" && job?.status !== "running") {
      throw new SoundboxError("soundbox_job_invalid");
    }
    if (attempt + 1 < maxPolls) await wait(1_500);
  }
  if (!soundId) throw new SoundboxError("soundbox_generation_timeout");
  let audio: Response;
  try {
    audio = await fetcher(
      `${config.baseUrl}/files/${soundId}.wav?format=mp3`,
      { headers, signal: AbortSignal.timeout(40_000) },
    );
  } catch { throw new SoundboxError("soundbox_audio_unreachable"); }
  if (!audio.ok) throw new SoundboxError("soundbox_audio_unavailable");
  return {
    model,
    bytes: await readMp3(audio, request.kind === "music" ? MAX_MUSIC_BYTES : MAX_SFX_BYTES),
    contentType: "audio/mpeg",
    durationSeconds,
  };
}
