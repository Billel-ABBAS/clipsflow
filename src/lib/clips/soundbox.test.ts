import { describe, expect, it, vi } from "vitest";
import { generateSoundboxAudio, resolveSoundboxConfig } from "./soundbox";

const env = {
  CLIPS_SOUNDBOX_ENABLED: "true",
  CLIPS_SOUNDBOX_BASE_URL: "http://soundbox:17494",
  CLIPS_SOUNDBOX_MODELS_COMMERCIAL_OK: "true",
};
const authorization = { explicitUserConsent: true, commercialLicenseConfirmed: true };
const id = "11111111-2222-4333-8444-555555555555";
const sound = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function responder(requests: Array<{ url: string; body?: Record<string, unknown> }>) {
  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    requests.push({
      url,
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    });
    if (url.endsWith("/api/generate")) {
      return Response.json({ job_id: id }, { status: 202 });
    }
    if (url.endsWith(`/api/jobs/${id}`)) {
      return Response.json({ status: "done", result: { sounds: [sound] } });
    }
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x03]).buffer, {
      headers: { "content-type": "audio/mpeg" },
    });
  });
}
describe("Soundbox private generation", () => {
  it("requires model licence approval, a private base URL and no browser token", () => {
    expect(() => resolveSoundboxConfig({ ...env, CLIPS_SOUNDBOX_ENABLED: "false" }))
      .toThrow("soundbox_disabled");
    expect(() => resolveSoundboxConfig({ ...env, CLIPS_SOUNDBOX_MODELS_COMMERCIAL_OK: "false" }))
      .toThrow("soundbox_models_not_approved");
    expect(() => resolveSoundboxConfig({ ...env, CLIPS_SOUNDBOX_BASE_URL: "http://example.com" }))
      .toThrow("soundbox_url_invalid");
    expect(() => resolveSoundboxConfig({ ...env, NEXT_PUBLIC_CLIPS_SOUNDBOX_PROXY_TOKEN: "oops" }))
      .toThrow("soundbox_public_secret_rejected");
    expect(() => resolveSoundboxConfig({ ...env, CLIPS_SOUNDBOX_BASE_URL: "https://audio.example.com" }))
      .toThrow("soundbox_proxy_auth_required");
  });
  it("produces an ACE-Step instrumental via asynchronous Soundbox jobs", async () => {
    const requests: Array<{url: string; body?: Record<string, unknown>}> = [];
    const fetcher = responder(requests);
    const audio = await generateSoundboxAudio({
      kind: "music", prompt: "Soft hopeful piano", shortDurationSeconds: 120,
      authorization,
    }, { environment: env, fetch: fetcher, sleep: async () => {}, maxPolls: 2 });
    expect(audio.model).toBe("audiocpp-ace-step");
    expect(audio.durationSeconds).toBe(60);
    expect(audio.bytes.byteLength).toBe(4);
    expect(requests[0].body).toMatchObject({
      model: "audiocpp-ace-step", lyrics: "", variations: 1, duration_s: 60,
    });
    expect(requests[0].body?.prompt).toContain("Instrumental only");
    expect(requests[2].url).toContain("?format=mp3");
  });
  it("uses MiDashengLM-Gen for short non-verbal effects", async () => {
    const requests: Array<{url: string; body?: Record<string, unknown>}> = [];
    await generateSoundboxAudio({
      kind: "sound_effect", prompt: "Digital pop in a dry studio",
      shortDurationSeconds: 40, authorization,
    }, { environment: env, fetch: responder(requests) });
    expect(requests[0].body).toMatchObject({
      model: "audiocpp-midashenglm-gen", duration_s: 2,
    });
  });
  it("blocks missing consent before reaching the provider", async () => {
    const fetcher = vi.fn();
    await expect(generateSoundboxAudio({
      kind: "music", prompt: "Piano solo", shortDurationSeconds: 30,
      authorization: { ...authorization, explicitUserConsent: false },
    }, { environment: env, fetch: fetcher })).rejects.toThrow("soundbox_consent_required");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects malformed provider job ids", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ job_id: "../secrets" }));
    await expect(generateSoundboxAudio({
      kind: "music", prompt: "Piano solo", shortDurationSeconds: 30,
      authorization,
    }, { environment: env, fetch: fetcher })).rejects.toThrow("soundbox_job_invalid");
  });
});
