import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { generateVoiceStudioNarration } from "./voicestudio";
import { generateSoundboxAudio } from "./soundbox";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});
async function redirectingService() {
  let redirectsFollowed = 0;
  const server = createServer((req, res) => {
    if (req.url === "/leak") {
      redirectsFollowed += 1;
      res.writeHead(503); res.end(); return;
    }
    res.writeHead(307, { location: "/leak" }); res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return { url: `http://127.0.0.1:${address.port}`, followed: () => redirectsFollowed };
}

describe("Private audio HTTP boundary", () => {
  it("does not forward a VoiceStudio request or its key through a redirect", async () => {
    const service = await redirectingService();
    await expect(generateVoiceStudioNarration({
      text: "Bonjour", authorization: {
        explicitConsent: true, voiceRightsConfirmed: true, commercialModelRightsConfirmed: true,
      },
    }, { environment: {
      CLIPS_VOICESTUDIO_ENABLED: "true", CLIPS_VOICESTUDIO_BASE_URL: service.url,
      CLIPS_VOICESTUDIO_API_KEY: "synthetic-key", CLIPS_VOICESTUDIO_TTS_MODEL: "approved-tts",
      CLIPS_VOICESTUDIO_TTS_VOICE: "approved-voice", CLIPS_VOICESTUDIO_MODEL_COMMERCIAL_OK: "true",
    } })).rejects.toThrow();
    expect(service.followed()).toBe(0);
  });
  it("does not follow a Soundbox redirect outside the configured API paths", async () => {
    const service = await redirectingService();
    await expect(generateSoundboxAudio({
      kind: "music", prompt: "A gentle piano", shortDurationSeconds: 20,
      authorization: { explicitUserConsent: true, commercialLicenseConfirmed: true },
    }, { environment: {
      CLIPS_SOUNDBOX_ENABLED: "true", CLIPS_SOUNDBOX_BASE_URL: service.url,
      CLIPS_SOUNDBOX_MODELS_COMMERCIAL_OK: "true",
    } })).rejects.toThrow();
    expect(service.followed()).toBe(0);
  });
});
