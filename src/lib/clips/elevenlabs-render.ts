import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ELEVENLABS_MAX_SFX_BYTES,
  ELEVENLABS_MAX_MUSIC_BYTES,
  ELEVENLABS_MUSIC_MODEL,
  ELEVENLABS_SOUND_MODEL,
  generateInstrumentalMusic,
  generateMotionSoundEffect,
  type GeneratedElevenLabsAudio,
  type MotionSoundEffectRequest,
} from "./elevenlabs";

const OUTPUT_BUCKET = "clip-outputs";

type AudioAssetKind = "music" | "sound_effect";

export interface ShortsElevenLabsAuthorization {
  enabled: boolean;
  explicit_consent: boolean;
  commercial_license_confirmed: boolean;
  use_cases: readonly ("instrumental_music" | "sound_effects")[];
  synthetic_voice: false;
}

export interface ShortsAudioAssetRequest {
  userId: string;
  projectId: string;
  candidateId: string;
  durationSeconds: number;
  kind: AudioAssetKind;
  prompt: string;
  atSeconds?: number;
  authorization: ShortsElevenLabsAuthorization;
}

export interface StoredShortsAudioAsset {
  bytes: Uint8Array;
  kind: AudioAssetKind;
  atSeconds?: number;
  model: typeof ELEVENLABS_MUSIC_MODEL | typeof ELEVENLABS_SOUND_MODEL;
}

/**
 * Pick a bounded, non-verbal instrumental direction using only local
 * transcript semantics. Raw transcript/title text is never sent to ElevenLabs.
 */
export function resolveShortsMusicPrompt(
  title: string,
  hook: string,
  motionTemplate: string,
  musicMood?: unknown,
): string {
  switch (musicMood) {
    case "focused":
      return "Focused contemporary instrumental bed with warm piano, a restrained low pulse, subtle percussion, and clear space around the foreground.";
    case "playful":
      return "Playful light instrumental bed with bouncy plucks, bright percussion, and a friendly, curious social-video feel.";
    case "uplifting":
      return "Warm uplifting instrumental bed with gentle piano, airy synth textures, light percussion, and a hopeful forward-moving feel.";
    case "warm":
      return "Reflective warm instrumental bed with soft piano, rounded ambient textures, and restrained pacing.";
    case "energetic":
      return "Upbeat energetic modern instrumental bed with crisp percussion, a confident pulse, and a bright concise social-video arrangement.";
    case "minimal":
      return "Minimal instrumental bed with soft ambient texture, sparse piano, very restrained percussion, and generous space around speech.";
  }

  const signal = `${title} ${hook}`.normalize("NFKC").toLocaleLowerCase();
  if (
    motionTemplate === "punchy-cuts" ||
    /\b(urgent|fast|growth|launch|challenge|win|viral|succès|réussir|rapidement)\b/iu.test(
      signal,
    )
  ) {
    return "Upbeat energetic modern instrumental bed with crisp percussion, a confident pulse, and a bright concise social-video arrangement.";
  }
  if (
    /\b(inspire|inspiration|hope|future|courage|espoir|avenir|inspirant|motivation)\b/iu.test(
      signal,
    )
  ) {
    return "Warm uplifting instrumental bed with gentle piano, airy synth textures, light percussion, and a hopeful forward-moving feel.";
  }
  if (
    /\b(story|memory|personal|life|histoire|souvenir|personnel|vie|émotion)\b/iu.test(
      signal,
    )
  ) {
    return "Reflective minimal instrumental bed with soft piano, warm ambient textures, and restrained pacing.";
  }
  return "Focused contemporary instrumental bed with warm piano, a restrained low pulse, subtle percussion, and clear space around the foreground.";
}

export function resolveShortsMotionEffect(
  motionTemplate: string,
): { prompt: string; atSeconds: number; durationSeconds: number } | null {
  switch (motionTemplate) {
    case "punchy-cuts":
      return {
        prompt: "Short soft percussive whoosh accent, polished and non-verbal.",
        atSeconds: 1.8,
        durationSeconds: 1.2,
      };
    case "kinetic-captions":
      return {
        prompt:
          "Brief light digital pop accent, clean, subtle, and non-verbal.",
        atSeconds: 1.8,
        durationSeconds: 0.8,
      };
    default:
      return null;
  }
}

function assetModel(kind: AudioAssetKind): StoredShortsAudioAsset["model"] {
  return kind === "music" ? ELEVENLABS_MUSIC_MODEL : ELEVENLABS_SOUND_MODEL;
}

function maximumAssetBytes(kind: AudioAssetKind): number {
  return kind === "music"
    ? ELEVENLABS_MAX_MUSIC_BYTES
    : ELEVENLABS_MAX_SFX_BYTES;
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

type ShortsAudioAssetCacheRequest = Pick<
  ShortsAudioAssetRequest,
  "userId" | "projectId" | "candidateId" | "kind" | "prompt"
>;

function assetFolder(request: ShortsAudioAssetCacheRequest): string {
  return `${request.userId}/shorts/${request.projectId}/${request.candidateId}`;
}

function fallbackAssetPath(request: ShortsAudioAssetCacheRequest): string {
  return `${assetFolder(request)}/${request.kind}-${promptHash(request.prompt)}.mp3`;
}

async function resolveStoredAssetPath(
  admin: SupabaseClient,
  request: ShortsAudioAssetCacheRequest,
): Promise<string> {
  const hash = promptHash(request.prompt);
  const { data: assetRows, error } = await admin
    .from("shorts_audio_assets")
    .select("storage_path")
    .eq("user_id", request.userId)
    .eq("project_id", request.projectId)
    .eq("candidate_id", request.candidateId)
    .eq("provider", "elevenlabs")
    .eq("kind", request.kind)
    .eq("model_id", assetModel(request.kind))
    .eq("prompt_hash", hash)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error("shorts_audio_asset_lookup_failed");

  const storedPath =
    Array.isArray(assetRows) &&
    assetRows[0] &&
    typeof assetRows[0].storage_path === "string"
      ? assetRows[0].storage_path
      : null;
  const prefix = `${assetFolder(request)}/`;
  return storedPath?.startsWith(prefix)
    ? storedPath
    : fallbackAssetPath(request);
}

/** Check the same private cache used by the renderer without requiring a provider key. */
export async function hasCachedShortsAudioAsset(
  admin: SupabaseClient,
  request: ShortsAudioAssetCacheRequest,
): Promise<boolean> {
  const path = await resolveStoredAssetPath(admin, request);
  const separator = path.lastIndexOf("/");
  if (separator < 1) return false;
  const folder = path.slice(0, separator);
  const name = path.slice(separator + 1);
  const { data: objects, error } = await admin.storage
    .from(OUTPUT_BUCKET)
    .list(folder, { limit: 100, search: name });
  if (error) throw new Error("shorts_audio_asset_lookup_failed");
  return (objects ?? []).some((object) => object.name === name);
}

async function tryDownloadStoredAsset(
  admin: SupabaseClient,
  path: string,
  request: ShortsAudioAssetCacheRequest,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  if (!path.startsWith(`${assetFolder(request)}/`)) return null;
  const { data, error } = await admin.storage
    .from(OUTPUT_BUCKET)
    .download(path);
  if (error || !data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) return null;
  return bytes;
}

/** Generate once per prompt hash, keep the asset private, and reuse on retry. */
export async function getOrCreateShortsAudioAsset(
  admin: SupabaseClient,
  request: ShortsAudioAssetRequest,
): Promise<StoredShortsAudioAsset> {
  if (
    !request.authorization.enabled ||
    !request.authorization.explicit_consent ||
    !request.authorization.commercial_license_confirmed ||
    request.authorization.synthetic_voice !== false ||
    (request.kind === "music" &&
      !request.authorization.use_cases.includes("instrumental_music")) ||
    (request.kind === "sound_effect" &&
      !request.authorization.use_cases.includes("sound_effects"))
  ) {
    throw new Error("elevenlabs_consent_required");
  }
  const maximumBytes = maximumAssetBytes(request.kind);
  const hash = promptHash(request.prompt);
  const model = assetModel(request.kind);
  const path = await resolveStoredAssetPath(admin, request);
  const existingBytes = await tryDownloadStoredAsset(
    admin,
    path,
    request,
    maximumBytes,
  );
  if (existingBytes) {
    return {
      bytes: existingBytes,
      kind: request.kind,
      ...(request.atSeconds === undefined
        ? {}
        : { atSeconds: request.atSeconds }),
      model,
    };
  }

  const authorization = {
    explicitUserConsent: request.authorization.explicit_consent,
    commercialLicenseConfirmed:
      request.authorization.commercial_license_confirmed,
  };
  let generated: GeneratedElevenLabsAudio;
  if (request.kind === "music") {
    generated = await generateInstrumentalMusic({
      shortDurationSeconds: request.durationSeconds,
      prompt: request.prompt,
      authorization,
    });
  } else {
    const sfxRequest: MotionSoundEffectRequest = {
      shortDurationSeconds: request.durationSeconds,
      atSeconds: request.atSeconds,
      durationSeconds: Math.min(3, Math.max(0.5, request.durationSeconds / 20)),
      prompt: request.prompt,
      authorization,
    };
    generated = await generateMotionSoundEffect(sfxRequest);
  }
  if (generated.contentType !== "audio/mpeg") {
    throw new Error("elevenlabs_audio_format_unsupported");
  }

  const { error: uploadError } = await admin.storage
    .from(OUTPUT_BUCKET)
    .upload(path, Buffer.from(generated.bytes), {
      contentType: generated.contentType,
      upsert: true,
    });
  if (uploadError) throw new Error("shorts_audio_asset_storage_failed");

  const { error: insertError } = await admin
    .from("shorts_audio_assets")
    .insert({
      user_id: request.userId,
      project_id: request.projectId,
      candidate_id: request.candidateId,
      provider: "elevenlabs",
      kind: request.kind,
      model_id: generated.model,
      prompt_hash: hash,
      storage_path: path,
      duration_seconds: generated.durationSeconds,
      license_reference: "end-user-confirmed-commercial-use",
    });
  if (insertError) throw new Error("shorts_audio_asset_persist_failed");

  return {
    bytes: generated.bytes,
    kind: request.kind,
    ...(request.atSeconds === undefined
      ? {}
      : { atSeconds: request.atSeconds }),
    model: generated.model,
  };
}
