import { describe, expect, it, vi } from "vitest";
import {
  VoiceStudioError,
  generateVoiceStudioNarration,
  resolveVoiceStudioConfig,
  type VoiceStudioEnvironment,
} from "./voicestudio";

const env: VoiceStudioEnvironment = {
  CLIPS_VOICESTUDIO_ENABLED: "true",
  CLIPS_VOICESTUDIO_BASE_URL: "http://voicestudio:3900",
  CLIPS_VOICESTUDIO_API_KEY: "private-test-key",
  CLIPS_VOICESTUDIO_TTS_MODEL: "cosyvoice-3",
  CLIPS_VOICESTUDIO_TTS_VOICE: "alloy",
  CLIPS_VOICESTUDIO_MODEL_COMMERCIAL_OK: "true",
};
const authorization = {
  explicitConsent: true,
  voiceRightsConfirmed: true,
  commercialModelRightsConfirmed: true,
};
function wav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WAVE", 8, "ascii");
  return bytes;
}

describe("VoiceStudio private boundary", () => {
  it("stays disabled and refuses commercial-unapproved models", () => {
    expect(() => resolveVoiceStudioConfig({ ...env, CLIPS_VOICESTUDIO_ENABLED: "false" }))
      .toThrow("voicestudio_disabled");
    expect(() => resolveVoiceStudioConfig({ ...env, CLIPS_VOICESTUDIO_MODEL_COMMERCIAL_OK: "false" }))
      .toThrow("voicestudio_model_not_commercially_approved");
    expect(() => resolveVoiceStudioConfig({ ...env, CLIPS_VOICESTUDIO_TTS_MODEL: "" }))
      .toThrow("voicestudio_not_configured");
  });

  it("never accepts a browser key or an arbitrary plaintext internet host", () => {
    expect(() => resolveVoiceStudioConfig({ ...env, NEXT_PUBLIC_CLIPS_VOICESTUDIO_API_KEY: "oops" }))
      .toThrow("voicestudio_public_secret_rejected");
    expect(() => resolveVoiceStudioConfig({ ...env, CLIPS_VOICESTUDIO_BASE_URL: "http://example.com" }))
      .toThrow("voicestudio_url_invalid");
    expect(() => resolveVoiceStudioConfig({ ...env, CLIPS_VOICESTUDIO_BASE_URL: "https://user:pass@example.com" }))
      .toThrow("voicestudio_url_invalid");
  });

  it("requires explicit consent before any network request", async () => {
    const fetcher = vi.fn();
    await expect(generateVoiceStudioNarration(
      { text: "Bonjour", authorization: { ...authorization, voiceRightsConfirmed: false } },
      { environment: env, fetch: fetcher },
    )).rejects.toBeInstanceOf(VoiceStudioError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("calls VoiceStudio's OpenAI-compatible private speech API", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(wav(), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    }));
    const output = await generateVoiceStudioNarration(
      { text: "Bonjour Clipsflow", authorization },
      { environment: env, fetch: fetcher },
    );
    expect(output.contentType).toBe("audio/wav");
    expect(output.bytes.byteLength).toBe(44);
    expect(fetcher).toHaveBeenCalledWith(
      "http://voicestudio:3900/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer private-test-key" }),
        body: JSON.stringify({
          model: "cosyvoice-3",
          voice: "alloy",
          input: "Bonjour Clipsflow",
          response_format: "wav",
        }),
      }),
    );
  });

  it("rejects invalid provider bytes and capacity errors", async () => {
    const broken = vi.fn().mockResolvedValue(new Response("not audio", {
      status: 200,
      headers: { "content-type": "audio/wav" },
    }));
    await expect(generateVoiceStudioNarration(
      { text: "Bonjour", authorization }, { environment: env, fetch: broken },
    )).rejects.toThrow("voicestudio_audio_invalid");
    const busy = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    await expect(generateVoiceStudioNarration(
      { text: "Bonjour", authorization }, { environment: env, fetch: busy },
    )).rejects.toThrow("voicestudio_capacity_exceeded");
  });
});
