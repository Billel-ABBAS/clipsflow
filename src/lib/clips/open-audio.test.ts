import { it } from "vitest";
import assert from "node:assert/strict";
import { resolveOpenAudioConfig, generateAceMusic, OPEN_MUSIC_MODEL } from "./open-audio";

const env = {
  CLIPS_OPEN_AUDIO_ENABLED: "true",
  CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED: "true",
  CLIPS_OPEN_AUDIO_BASE_URL: "https://audio.example.test",
  CLIPS_OPEN_AUDIO_API_KEY: "private-test-token",
};
const cfg = () => resolveOpenAudioConfig(env);
const json = (data: unknown) => new Response(JSON.stringify({ code: 200, error: null, data }));
const request = { prompt: "Soft piano instrumental", durationSeconds: 20 };
const audio = () => new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), { headers: { "content-type": "audio/mpeg" } });

it("requires explicit local compute approval, not a paid provider key", () => {
  assert.throws(() => resolveOpenAudioConfig({}), /disabled/);
  assert.throws(() => resolveOpenAudioConfig({ ...env, CLIPS_OPEN_AUDIO_COMPUTE_AUTHORIZED: "false" }), /compute/);
  assert.equal(cfg().baseUrl, "https://audio.example.test");
  assert.throws(() => resolveOpenAudioConfig({ CLIPS_ELEVENLABS_ENABLED: "true", ELEVENLABS_API_KEY: "legacy" }), /disabled/);
});
it("rejects insecure remote, proprietary, credentialed and public-key configurations", () => {
  for (const url of ["http://audio.example.test", "https://api.elevenlabs.io", "https://user:pass@audio.example.test", "https://audio.example.test/path", "https://audio.example.test?x=1"]) {
    assert.throws(() => resolveOpenAudioConfig({ ...env, CLIPS_OPEN_AUDIO_BASE_URL: url }));
  }
  assert.throws(() => resolveOpenAudioConfig({ ...env, CLIPS_OPEN_AUDIO_API_KEY: "" }));
  assert.throws(() => resolveOpenAudioConfig({ ...env, NEXT_PUBLIC_OPEN_AUDIO_API_KEY: "exposed" }));
  assert.equal(resolveOpenAudioConfig({ ...env, CLIPS_OPEN_AUDIO_BASE_URL: "http://127.0.0.1:8001", CLIPS_OPEN_AUDIO_API_KEY: "" }).baseUrl, "http://127.0.0.1:8001");
});
it("uses the native ACE-Step protocol with one instrumental sample and private bearer auth", async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-test-token");
    assert.ok(init?.signal);
    if (urls.length === 1) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, OPEN_MUSIC_MODEL);
      assert.equal(body.lyrics, "[Instrumental]");
      assert.equal(body.audio_duration, 20);
      assert.equal(body.batch_size, 1);
      assert.equal(body.audio_format, "mp3");
      return json({ task_id: "job-1" });
    }
    if (urls.length === 2) return json([{ task_id: "job-1", status: 1, result: JSON.stringify([{ file: "/v1/audio?path=sample.mp3" }]) }]);
    return audio();
  };
  const result = await generateAceMusic(request, cfg(), { fetch: fetcher, sleep: async () => {} });
  assert.equal(result.taskId, "job-1");
  assert.deepEqual([...result.bytes], [0x49, 0x44, 0x33, 1]);
  assert.deepEqual(urls.map((url) => new URL(url).pathname), ["/release_task", "/query_result", "/v1/audio"]);
});
it("rejects invalid duration before submitting any compute", async () => {
  for (const durationSeconds of [NaN, Infinity, -1, 0, 2, 181]) {
    await assert.rejects(generateAceMusic({ ...request, durationSeconds }, cfg(), { fetch: async () => { throw Error("network-called"); } }), /input/);
  }
});
it("rejects foreign or non-audio result URLs without disclosing the token", async () => {
  for (const file of ["https://evil.example/file.mp3", "//evil.example/x", "/health", "/v1/audio", "/v1/audio?path=x&token=evil"]) {
    let calls = 0;
    await assert.rejects(generateAceMusic(request, cfg(), { fetch: async () => ++calls === 1 ? json({ task_id: "job-1" }) : json([{ task_id: "job-1", status: 1, result: JSON.stringify([{ file }]) }]), sleep: async () => {} }), /result/);
    assert.equal(calls, 2);
  }
});
it("rejects failed, unknown, malformed and oversized JSON responses", async () => {
  for (const response of [new Response("{}", { status: 503 }), new Response("not-json"), new Response(" ".repeat(70_000)), json({}), new Response(JSON.stringify({ code: 500, error: "private upstream detail" }))]) {
    await assert.rejects(generateAceMusic(request, cfg(), { fetch: async () => response }), /open_audio/);
  }
});
it("bounds polling, never resubmits and rejects audio content-type/size violations", async () => {
  let calls = 0;
  await assert.rejects(generateAceMusic(request, cfg(), { fetch: async () => ++calls === 1 ? json({ task_id: "job-1" }) : json([{ task_id: "job-1", status: 0 }]), sleep: async () => {} }), /timeout/);
  assert.equal(calls, 61);
  for (const response of [new Response("html", { headers: { "content-type": "text/html" } }), new Response("x", { headers: { "content-type": "audio/mpeg", "content-length": String(33 * 1024 * 1024) } })]) {
    calls = 0;
    await assert.rejects(generateAceMusic(request, cfg(), { fetch: async () => { calls++; return calls === 1 ? json({ task_id: "job-1" }) : calls === 2 ? json([{ task_id: "job-1", status: 1, result: JSON.stringify([{ file: "/v1/audio?path=x" }]) }]) : response; }, sleep: async () => {} }), /audio/);
  }
});
