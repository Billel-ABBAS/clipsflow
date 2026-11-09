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
  CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED: "true",
  CLIPS_OPEN_AUDIO_ENABLED: "true",
  CLIPS_OPEN_AUDIO_BASE_URL: "https://audio.example.test",
  CLIPS_OPEN_AUDIO_API_KEY: "private-test-token",
};

const authorization: ElevenLabsGenerationAuthorization = {
  explicitUserConsent: true,
  commercialLicenseConfirmed: true,
};

describe("Open Audio through legacy non-verbal sound design contract", () => {
  it("requires server-side feature, compute approval, and creator consent before a provider call", async () => {
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
    const json = (data: unknown) => new Response(JSON.stringify({ code: 200, error: null, data }));
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new URL(String(input)).origin).toBe("https://audio.example.test");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-test-token");
        if (String(input).endsWith("/release_task")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.model).toBe(ELEVENLABS_MUSIC_MODEL);
          expect(body.lyrics).toBe("[Instrumental]");
          expect(body.audio_duration).toBe(60);
          expect(body.prompt).toContain("No vocals");
          return json({ task_id: "song_123" });
        }
        if (String(input).endsWith("/query_result")) {
          return json([{ task_id: "song_123", status: 1, result: JSON.stringify([{ file: "/v1/audio?path=sample.mp3" }]) }]);
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
        });
      },
    );

    const result = await generateInstrumentalMusic(
      {
        shortDurationSeconds: 60,
        prompt: "Warm, restrained background music.",
        authorization,
      },
      { environment: enabledEnvironment, fetch, renderAudio: async (input) => input.bytes! },
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

  it("creates only short non-verbal motion effects without network calls", async () => {
    const fetch = vi.fn();
    const result = await generateMotionSoundEffect(
      {
        shortDurationSeconds: 45,
        atSeconds: 10,
        durationSeconds: 1.5,
        prompt: "Soft transition whoosh",
        authorization,
      },
      { environment: enabledEnvironment, fetch, renderAudio: async (input) => {
        expect(input.durationSeconds).toBe(1.5);
        expect(input.prompt).toContain("Non-verbal one-shot");
        return new Uint8Array([4, 5]);
      } },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "motion-sfx",
      model: ELEVENLABS_SOUND_MODEL,
      syntheticVoice: "prohibited",
      durationSeconds: 1.5,
    });
  });
});
