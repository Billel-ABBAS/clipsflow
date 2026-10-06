import { describe, expect, it, vi } from "vitest";

import {
  ELEVENLABS_MUSIC_MODEL,
  ELEVENLABS_SOUND_MODEL,
  generateInstrumentalMusic,
  generateMotionSoundEffect,
  type ElevenLabsEnvironment,
  type ElevenLabsGenerationAuthorization,
} from "./elevenlabs";

const enabledEnvironment: ElevenLabsEnvironment = {
  CLIPS_AI_BUDGET_AUTHORIZED: "true",
  CLIPS_ELEVENLABS_ENABLED: "true",
  ELEVENLABS_API_KEY: "test-elevenlabs-key",
};

const authorization: ElevenLabsGenerationAuthorization = {
  explicitUserConsent: true,
  commercialLicenseConfirmed: true,
};

describe("ElevenLabs non-verbal sound design", () => {
  it("requires server-side feature, budget, and creator consent before a provider call", async () => {
    const fetch = vi.fn();
    await expect(
      generateInstrumentalMusic(
        {
          shortDurationSeconds: 60,
          prompt: "Warm background texture",
          authorization,
        },
        { environment: {}, fetch },
      ),
    ).rejects.toMatchObject({ code: "paid_ai_not_authorized" });
    await expect(
      generateInstrumentalMusic(
        {
          shortDurationSeconds: 60,
          prompt: "Warm background texture",
          authorization: { ...authorization, explicitUserConsent: false },
        },
        { environment: enabledEnvironment, fetch },
      ),
    ).rejects.toMatchObject({ code: "elevenlabs_consent_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests instrumental music and returns bounded validated audio bytes", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain("/v1/music?");
        expect(new Headers(init?.headers).get("xi-api-key")).toBe(
          "test-elevenlabs-key",
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.model_id).toBe(ELEVENLABS_MUSIC_MODEL);
        expect(body.force_instrumental).toBe(true);
        expect(body.music_length_ms).toBe(60_000);
        expect(body.prompt).toContain("No vocals");
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg", "song-id": "song_123" },
        });
      },
    );

    const result = await generateInstrumentalMusic(
      {
        shortDurationSeconds: 60,
        prompt: "Warm, restrained background music.",
        authorization,
      },
      { environment: enabledEnvironment, fetch },
    );
    expect(result).toMatchObject({
      kind: "instrumental-music",
      model: ELEVENLABS_MUSIC_MODEL,
      syntheticVoice: "prohibited",
      durationSeconds: 60,
      contentType: "audio/mpeg",
      providerAssetId: "song_123",
    });
    expect([...result.bytes]).toEqual([1, 2, 3]);
  });

  it("rejects voice-oriented prompts and motion effects outside the short", async () => {
    const fetch = vi.fn();
    await expect(
      generateInstrumentalMusic(
        {
          shortDurationSeconds: 60,
          prompt: "Add narration here",
          authorization,
        },
        { environment: enabledEnvironment, fetch },
      ),
    ).rejects.toMatchObject({ code: "elevenlabs_voice_generation_prohibited" });
    await expect(
      generateMotionSoundEffect(
        {
          shortDurationSeconds: 20,
          atSeconds: 19,
          durationSeconds: 2,
          prompt: "Soft transition whoosh",
          authorization,
        },
        { environment: enabledEnvironment, fetch },
      ),
    ).rejects.toMatchObject({ code: "elevenlabs_input_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates only short non-verbal motion effects", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain("/v1/sound-generation?");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.model_id).toBe(ELEVENLABS_SOUND_MODEL);
        expect(body.loop).toBe(false);
        expect(body.duration_seconds).toBe(1.5);
        expect(body.text).toContain("Non-verbal one-shot");
        return new Response(new Uint8Array([4, 5]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
    );

    const result = await generateMotionSoundEffect(
      {
        shortDurationSeconds: 45,
        atSeconds: 10,
        durationSeconds: 1.5,
        prompt: "Soft transition whoosh",
        authorization,
      },
      { environment: enabledEnvironment, fetch },
    );
    expect(result).toMatchObject({
      kind: "motion-sfx",
      model: ELEVENLABS_SOUND_MODEL,
      syntheticVoice: "prohibited",
      durationSeconds: 1.5,
    });
  });
});
