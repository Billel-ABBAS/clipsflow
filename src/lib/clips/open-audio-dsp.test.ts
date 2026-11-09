import { it } from "vitest";
import assert from "node:assert/strict";
import { buildSfxFilter, renderOpenAudio } from "./open-audio-dsp";

it("selects only fixed nonverbal presets and never interpolates prompt commands", () => {
  assert.match(buildSfxFilter("digital pop", 1), /^sine=frequency=880/);
  assert.match(buildSfxFilter("soft impact", 1), /^sine=frequency=70/);
  assert.match(buildSfxFilter("whoosh; $(curl example.test)", 1), /^anoisesrc=/);
  assert.doesNotMatch(buildSfxFilter("pop; amovie=https://example.test", 1), /https|amovie/);
  for (const duration of [0, NaN, Infinity, 3.1]) assert.throws(() => buildSfxFilter("whoosh", duration));
});
it("renders actual MP3 accents locally without any network call", async () => {
  for (const prompt of ["soft whoosh", "digital pop", "short impact"]) {
    const bytes = await renderOpenAudio({ prompt, durationSeconds: 0.5 }, { binary: process.env.TEST_FFMPEG_PATH });
    assert.ok(bytes.byteLength > 500);
    assert.ok(bytes.byteLength < 40_000);
    assert.equal(Buffer.from(bytes).subarray(0, 3).toString(), "ID3");
  }
});
it("fails for invalid music, missing executable and out-of-range duration", async () => {
  await assert.rejects(renderOpenAudio({ bytes: new Uint8Array([1, 2, 3]), durationSeconds: 3 }, { binary: process.env.TEST_FFMPEG_PATH }), /open_audio/);
  await assert.rejects(renderOpenAudio({ prompt: "pop", durationSeconds: 1 }, { binary: "missing-clipsflow-ffmpeg" }), /open_audio/);
  await assert.rejects(renderOpenAudio({ prompt: "pop", durationSeconds: 10 }), /input/);
});
it("normalizes actual MP3 bytes to a bounded music track and rejects playlists", async () => {
  const options = { binary: process.env.TEST_FFMPEG_PATH };
  const source = await renderOpenAudio({ prompt: "pop", durationSeconds: 0.5 }, options);
  const output = await renderOpenAudio({ bytes: source, durationSeconds: 3 }, options);
  assert.ok(output.byteLength > source.byteLength * 3);
  assert.ok(output.byteLength < 80_000);
  await assert.rejects(renderOpenAudio({ bytes: Buffer.from("#EXTM3U\nfile:/etc/passwd\n"), durationSeconds: 3 }, options), /open_audio/);
});
