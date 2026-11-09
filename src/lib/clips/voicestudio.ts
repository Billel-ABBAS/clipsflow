/**
 * Private VoiceStudio TTS adapter for Clipsflow. No user-supplied host, model,
 * voice id, or API key may reach this boundary.
 *
 * VoiceStudio is AGPL-3.0; downloaded model weights have separate licences.
 * Its default OmniVoice weights are non-commercial. Fail closed until the
 * operator selects and approves a commercially usable model.
 */
export interface VoiceStudioEnvironment extends Record<string, string | undefined> {
  CLIPS_VOICESTUDIO_ENABLED?: string;
  CLIPS_VOICESTUDIO_BASE_URL?: string;
  CLIPS_VOICESTUDIO_API_KEY?: string;
  CLIPS_VOICESTUDIO_TTS_MODEL?: string;
  CLIPS_VOICESTUDIO_TTS_VOICE?: string;
  CLIPS_VOICESTUDIO_MODEL_COMMERCIAL_OK?: string;
  NEXT_PUBLIC_CLIPS_VOICESTUDIO_API_KEY?: string;
}

export interface VoiceStudioConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

export interface VoiceStudioAuthorization {
  explicitConsent: boolean;
  voiceRightsConfirmed: boolean;
  commercialModelRightsConfirmed: boolean;
}

export interface VoiceStudioNarrationRequest {
  text: string;
  authorization: VoiceStudioAuthorization;
}

export interface VoiceStudioNarration {
  bytes: Uint8Array;
  contentType: "audio/wav";
  model: string;
}

export class VoiceStudioError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "VoiceStudioError";
  }
}

const MAX_TEXT_LENGTH = 2_000;
const MAX_WAV_BYTES = 16 * 1024 * 1024;

function validIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/u.test(value);
}

export function resolveVoiceStudioConfig(
  env: VoiceStudioEnvironment = process.env,
): VoiceStudioConfig {
  if (env.CLIPS_VOICESTUDIO_ENABLED !== "true") {
    throw new VoiceStudioError("voicestudio_disabled");
  }
  if (env.NEXT_PUBLIC_CLIPS_VOICESTUDIO_API_KEY?.trim()) {
    throw new VoiceStudioError("voicestudio_public_secret_rejected");
  }
  if (env.CLIPS_VOICESTUDIO_MODEL_COMMERCIAL_OK !== "true") {
    throw new VoiceStudioError("voicestudio_model_not_commercially_approved");
  }

  const model = env.CLIPS_VOICESTUDIO_TTS_MODEL?.trim() ?? "";
  const voice = env.CLIPS_VOICESTUDIO_TTS_VOICE?.trim() ?? "";
  const apiKey = env.CLIPS_VOICESTUDIO_API_KEY?.trim() ?? "";
  const base = env.CLIPS_VOICESTUDIO_BASE_URL?.trim() ?? "";
  if (!validIdentifier(model) || !validIdentifier(voice) || !apiKey || !base) {
    throw new VoiceStudioError("voicestudio_not_configured");
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new VoiceStudioError("voicestudio_url_invalid");
  }
  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  const privateHost =
    localHost ||
    (!url.hostname.includes(".") && /^[a-z0-9-]+$/iu.test(url.hostname)) ||
    url.hostname.endsWith(".internal");
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && privateHost)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new VoiceStudioError("voicestudio_url_invalid");
  }
  return {
    baseUrl: url.origin,
    apiKey,
    model,
    voice,
  };
}

async function readWav(response: Response): Promise<Uint8Array> {
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!["audio/wav", "audio/x-wav", "audio/wave"].includes(mime ?? "")) {
    throw new VoiceStudioError("voicestudio_audio_format_invalid");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WAV_BYTES) {
    throw new VoiceStudioError("voicestudio_audio_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new VoiceStudioError("voicestudio_audio_empty");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_WAV_BYTES) {
        await reader.cancel();
        throw new VoiceStudioError("voicestudio_audio_too_large");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let pos = 0;
  for (const part of parts) {
    bytes.set(part, pos);
    pos += part.byteLength;
  }
  // Reject HTML/JSON/error bodies masquerading as audio.
  const header = Buffer.from(bytes.subarray(0, 12));
  if (size < 44 || header.toString("ascii", 0, 4) !== "RIFF" ||
      header.toString("ascii", 8, 12) !== "WAVE") {
    throw new VoiceStudioError("voicestudio_audio_invalid");
  }
  return bytes;
}

/** Called by a gated worker only; this does not expose a public speech API. */
export async function generateVoiceStudioNarration(
  request: VoiceStudioNarrationRequest,
  options: {
    environment?: VoiceStudioEnvironment;
    fetch?: typeof fetch;
  } = {},
): Promise<VoiceStudioNarration> {
  if (!request.authorization?.explicitConsent ||
      !request.authorization.voiceRightsConfirmed ||
      !request.authorization.commercialModelRightsConfirmed) {
    throw new VoiceStudioError("voicestudio_consent_required");
  }
  const text = request.text?.normalize("NFKC").trim();
  if (!text || text.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new VoiceStudioError("voicestudio_text_invalid");
  }
  const config = resolveVoiceStudioConfig(options.environment);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${config.baseUrl}/v1/audio/speech`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          voice: config.voice,
          input: text,
          response_format: "wav",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(90_000),
      },
    );
  } catch {
    throw new VoiceStudioError("voicestudio_unreachable");
  }
  if (!response.ok) {
    throw new VoiceStudioError(
      response.status === 429 ? "voicestudio_capacity_exceeded" : "voicestudio_failed",
    );
  }
  return {
    bytes: await readWav(response),
    contentType: "audio/wav",
    model: config.model,
  };
}
