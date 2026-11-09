// ============================================================================
// ClipsFlow Shorts — legacy API names; execution is exclusively open-source.
// Serialized names stay compatible with existing jobs. No ElevenLabs fallback.
// Music: self-hosted ACE-Step 1.5. Motion accents: local FFmpeg synthesis.
// ============================================================================
import {
  OPEN_MUSIC_MODEL, OPEN_SFX_MODEL, generateAceMusic, resolveOpenAudioConfig,
  type OpenAudioConfig,
} from "./open-audio";

export const ELEVENLABS_MUSIC_MODEL = OPEN_MUSIC_MODEL;
export const ELEVENLABS_SOUND_MODEL = OPEN_SFX_MODEL;
export const ELEVENLABS_MAX_SHORT_DURATION_SECONDS = 180;
export const ELEVENLABS_MIN_MUSIC_DURATION_SECONDS = 3;
export const ELEVENLABS_MAX_MUSIC_DURATION_SECONDS = 600;
export const ELEVENLABS_MIN_SFX_DURATION_SECONDS = 0.5;
export const ELEVENLABS_MAX_SFX_DURATION_SECONDS = 30;
/** Product-level cap: effects in a Short are short accents, not a soundtrack. */
export const ELEVENLABS_MAX_MOTION_SFX_DURATION_SECONDS = 3;
export const ELEVENLABS_MAX_MOTION_SFX_PER_SHORT = 2;
export const ELEVENLABS_MAX_MUSIC_BYTES = 32 * 1024 * 1024;
export const ELEVENLABS_MAX_SFX_BYTES = 8 * 1024 * 1024;

/** Compatibility export; consent now covers the self-hosted models and compute. */
export const ELEVENLABS_CONSENT_AND_LICENSE_NOTICE =
  "La génération utilise ACE-Step auto-hébergé pour la musique instrumentale et FFmpeg pour les accents sonores. Confirmez votre accord, les droits sur vos contenus et l'autorisation du calcul local ou hébergé. Aucun service ElevenLabs n'est appelé.";

export type ElevenLabsErrorCode =
  | "elevenlabs_disabled"
  | "paid_ai_not_authorized"
  | "elevenlabs_unavailable"
  | "elevenlabs_consent_required"
  | "elevenlabs_input_invalid"
  | "elevenlabs_voice_generation_prohibited"
  | "elevenlabs_provider_failed"
  | "elevenlabs_invalid_audio";

/** Stable, non-sensitive errors for jobs and API handlers. */
export class ElevenLabsError extends Error {
  constructor(
    public readonly code: ElevenLabsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

export interface ElevenLabsEnvironment extends Record<string, string | undefined> {
  CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED?: string;
  CLIPS_OPEN_AUDIO_ENABLED?: string;
  CLIPS_OPEN_AUDIO_BASE_URL?: string;
  CLIPS_OPEN_AUDIO_API_KEY?: string;
  NEXT_PUBLIC_OPEN_AUDIO_API_KEY?: string;
}

export interface ElevenLabsConfig extends OpenAudioConfig {
  musicModel: typeof ELEVENLABS_MUSIC_MODEL;
  soundModel: typeof ELEVENLABS_SOUND_MODEL;
}

export interface ElevenLabsGenerationAuthorization {
  /** Account-holder confirmation, collected before a worker queues media. */
  explicitUserConsent: boolean;
  /** The caller accepts responsibility for the intended commercial use. */
  commercialLicenseConfirmed: boolean;
}

export interface InstrumentalMusicRequest {
  /** Exact selected-Short duration; generation cannot exceed the product cap. */
  shortDurationSeconds: unknown;
  /** A concise creative description, normally supplied by the creative director. */
  prompt: unknown;
  authorization: ElevenLabsGenerationAuthorization;
}

export interface MotionSoundEffectRequest {
  /** Exact selected-Short duration, bounded to 180 seconds. */
  shortDurationSeconds: unknown;
  /** Offset in the Short at which the renderer will place the one-shot effect. */
  atSeconds: unknown;
  /** The effect's own duration, product-capped at 3 seconds. */
  durationSeconds: unknown;
  /** Concise, non-verbal sound description. */
  prompt: unknown;
  authorization: ElevenLabsGenerationAuthorization;
}

export interface GeneratedElevenLabsAudio {
  kind: "instrumental-music" | "motion-sfx";
  model: typeof ELEVENLABS_MUSIC_MODEL | typeof ELEVENLABS_SOUND_MODEL;
  /** Non-verbal by contract. A renderer mixes this underneath original speech. */
  syntheticVoice: "prohibited";
  durationSeconds: number;
  contentType: string;
  bytes: Uint8Array;
  /** Self-hosted ACE-Step task id, or null for a locally synthesized accent. */
  providerAssetId: string | null;
  /** Compatibility only. There are no ElevenLabs billed characters. */
  billedCharacters: number | null;
}

export type ElevenLabsFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type AudioRenderer = (input: {
  prompt?: string; bytes?: Uint8Array; durationSeconds: number;
}) => Promise<Uint8Array>;

export interface ElevenLabsRunOptions {
  /** Dependency injection keeps unit tests offline and workers deterministic. */
  fetch?: ElevenLabsFetch;
  environment?: ElevenLabsEnvironment;
  renderAudio?: AudioRenderer;
}

function normalizeWhitespace(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function invalidInput(message: string): never {
  throw new ElevenLabsError("elevenlabs_input_invalid", message);
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidInput(`elevenlabs_${field}_invalid`);
  }
  return value;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function validateShortDuration(value: unknown): number {
  const duration = requireFiniteNumber(value, "short_duration");
  if (duration <= 0 || duration > ELEVENLABS_MAX_SHORT_DURATION_SECONDS) {
    invalidInput("elevenlabs_short_duration_invalid");
  }
  return roundMilliseconds(duration);
}

const VOICE_REQUEST_PATTERN =
  /\b(?:voice(?:over)?|vocal(?:s)?|speech|spoken|narrat(?:ion|e)|dialogue|lyrics?|sing(?:ing|er)?|voix|vocal(?:e|es)?|parl(?:e|é|er)|narration|doublage|paroles?|chant(?:er|é|e|s)?)\b/iu;

/**
 * Normalise user/model text and reject voice-oriented requests before they can
 * reach the music model. No audio reference or cloning input is accepted.
 */
export function normalizeNonVerbalAudioPrompt(
  value: unknown,
  maximumLength = 600,
): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    invalidInput("elevenlabs_prompt_limit_invalid");
  }
  if (typeof value !== "string") invalidInput("elevenlabs_prompt_invalid");
  const prompt = normalizeWhitespace(value).slice(0, maximumLength);
  if (!prompt) invalidInput("elevenlabs_prompt_invalid");
  if (VOICE_REQUEST_PATTERN.test(prompt)) {
    throw new ElevenLabsError(
      "elevenlabs_voice_generation_prohibited",
      "elevenlabs_voice_generation_prohibited",
    );
  }
  return prompt;
}

function requireAuthorization(
  authorization: ElevenLabsGenerationAuthorization,
): void {
  if (
    authorization?.explicitUserConsent !== true ||
    authorization?.commercialLicenseConfirmed !== true
  ) {
    throw new ElevenLabsError(
      "elevenlabs_consent_required",
      "elevenlabs_consent_and_license_confirmation_required",
    );
  }
}

/** Old provider keys/flags cannot activate the replacement. */
export function resolveElevenLabsConfig(
  environment: ElevenLabsEnvironment = process.env as ElevenLabsEnvironment,
): ElevenLabsConfig {
  if (environment.CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED !== "true") {
    throw new ElevenLabsError("paid_ai_not_authorized", "open_audio_compute_not_authorized");
  }
  if (environment.CLIPS_OPEN_AUDIO_ENABLED !== "true") {
    throw new ElevenLabsError("elevenlabs_disabled", "open_audio_disabled");
  }
  try {
    return {
      ...resolveOpenAudioConfig(environment),
      musicModel: ELEVENLABS_MUSIC_MODEL,
      soundModel: ELEVENLABS_SOUND_MODEL,
    };
  } catch {
    throw new ElevenLabsError("elevenlabs_unavailable", "open_audio_configuration_invalid");
  }
}

function parseNonNegativeHeader(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000
    ? parsed
    : null;
}

function parseProviderAssetId(value: string | null): string | null {
  const candidate = value?.trim() ?? "";
  return /^[A-Za-z0-9_-]{1,128}$/u.test(candidate) ? candidate : null;
}

function contentTypeFrom(response: Response): string {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (!value || !/^audio\/[A-Za-z0-9.+-]+$/u.test(value)) {
    throw new ElevenLabsError(
      "elevenlabs_invalid_audio",
      "elevenlabs_audio_content_type_invalid",
    );
  }
  return value.toLowerCase();
}

async function readAudioBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = parseNonNegativeHeader(
    response.headers.get("content-length"),
  );
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new ElevenLabsError(
      "elevenlabs_invalid_audio",
      "elevenlabs_audio_too_large",
    );
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
      throw new ElevenLabsError(
        "elevenlabs_invalid_audio",
        "elevenlabs_audio_size_invalid",
      );
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new ElevenLabsError(
          "elevenlabs_invalid_audio",
          "elevenlabs_audio_too_large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new ElevenLabsError(
      "elevenlabs_invalid_audio",
      "elevenlabs_audio_empty",
    );
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface AudioRequestDetails {
  body: Record<string, unknown>;
  config: ElevenLabsConfig;
  maximumBytes: number;
  kind: GeneratedElevenLabsAudio["kind"];
  model: GeneratedElevenLabsAudio["model"];
  durationSeconds: number;
}

async function requestGeneratedAudio(
  details: AudioRequestDetails,
  fetchImplementation: ElevenLabsFetch,
  renderAudio?: AudioRenderer,
): Promise<GeneratedElevenLabsAudio> {
  let response: Response;
  try {
    const render = renderAudio ?? (await import("./open-audio-dsp")).renderOpenAudio;
    const generated = details.kind === "instrumental-music"
      ? await generateAceMusic({ prompt: String(details.body.prompt), durationSeconds: details.durationSeconds }, details.config, { fetch: fetchImplementation })
      : null;
    const bytes = await render({
      ...(generated ? { bytes: generated.bytes } : { prompt: String(details.body.text) }),
      durationSeconds: details.durationSeconds,
    });
    response = new Response(Uint8Array.from(bytes), {
      headers: { "content-type": "audio/mpeg", ...(generated ? { "song-id": generated.taskId } : {}) },
    });
  } catch {
    throw new ElevenLabsError(
      "elevenlabs_provider_failed",
      "open_audio_provider_failed",
    );
  }

  if (!response.ok) {
    throw new ElevenLabsError(
      "elevenlabs_provider_failed",
      "elevenlabs_provider_failed",
    );
  }

  try {
    return {
      kind: details.kind,
      model: details.model,
      syntheticVoice: "prohibited",
      durationSeconds: details.durationSeconds,
      contentType: contentTypeFrom(response),
      bytes: await readAudioBytes(response, details.maximumBytes),
      providerAssetId: parseProviderAssetId(response.headers.get("song-id")),
      billedCharacters: null,
    };
  } catch (error) {
    if (error instanceof ElevenLabsError) throw error;
    throw new ElevenLabsError(
      "elevenlabs_provider_failed",
      "elevenlabs_provider_failed",
    );
  }
}

function resolveFetch(options: ElevenLabsRunOptions): ElevenLabsFetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ElevenLabsError(
      "elevenlabs_unavailable",
      "elevenlabs_fetch_unavailable",
    );
  }
  return fetchImplementation;
}

/**
 * Generate an instrumental bed, then normalize/trim locally to the Short.
 * ACE-Step gets at least 10 seconds; shorter clips are trimmed by FFmpeg.
 */
export async function generateInstrumentalMusic(
  request: InstrumentalMusicRequest,
  options: ElevenLabsRunOptions = {},
): Promise<GeneratedElevenLabsAudio> {
  const shortDurationSeconds = validateShortDuration(
    request.shortDurationSeconds,
  );
  if (
    shortDurationSeconds < ELEVENLABS_MIN_MUSIC_DURATION_SECONDS ||
    shortDurationSeconds > ELEVENLABS_MAX_MUSIC_DURATION_SECONDS
  ) {
    invalidInput("elevenlabs_music_duration_invalid");
  }
  const prompt = normalizeNonVerbalAudioPrompt(request.prompt, 600);
  requireAuthorization(request.authorization);
  const config = resolveElevenLabsConfig(options.environment);

  return requestGeneratedAudio(
    {
      body: {
        model_id: config.musicModel,
        prompt: `Instrumental background music only. No vocals, lyrics, speech, or synthetic voice. ${prompt}`,
        music_length_ms: Math.round(shortDurationSeconds * 1_000),
        force_instrumental: true,
      },
      config,
      maximumBytes: ELEVENLABS_MAX_MUSIC_BYTES,
      kind: "instrumental-music",
      model: config.musicModel,
      durationSeconds: shortDurationSeconds,
    },
    resolveFetch(options),
    options.renderAudio,
  );
}

/**
 * Generate one short, non-looping SFX accent for a bounded position in a
 * selected Short. Long ambience, music beds, speech, vocals, and voices are
 * intentionally rejected by the input contract.
 */
export async function generateMotionSoundEffect(
  request: MotionSoundEffectRequest,
  options: ElevenLabsRunOptions = {},
): Promise<GeneratedElevenLabsAudio> {
  const shortDurationSeconds = validateShortDuration(
    request.shortDurationSeconds,
  );
  const atSeconds = requireFiniteNumber(request.atSeconds, "sfx_offset");
  const durationSeconds = requireFiniteNumber(
    request.durationSeconds,
    "sfx_duration",
  );
  if (
    atSeconds < 0 ||
    durationSeconds < ELEVENLABS_MIN_SFX_DURATION_SECONDS ||
    durationSeconds > ELEVENLABS_MAX_MOTION_SFX_DURATION_SECONDS ||
    atSeconds + durationSeconds > shortDurationSeconds
  ) {
    invalidInput("elevenlabs_sfx_duration_or_placement_invalid");
  }
  const prompt = normalizeNonVerbalAudioPrompt(request.prompt, 320);
  requireAuthorization(request.authorization);
  const config = resolveElevenLabsConfig(options.environment);

  return requestGeneratedAudio(
    {
      body: {
        model_id: config.soundModel,
        text: `Non-verbal one-shot sound effect only. No speech, vocals, dialogue, or voice. ${prompt}`,
        duration_seconds: roundMilliseconds(durationSeconds),
        loop: false,
        prompt_influence: 0.35,
      },
      config,
      maximumBytes: ELEVENLABS_MAX_SFX_BYTES,
      kind: "motion-sfx",
      model: config.soundModel,
      durationSeconds: roundMilliseconds(durationSeconds),
    },
    resolveFetch(options),
    options.renderAudio,
  );
}
