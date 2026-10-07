import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OutboundUrlError,
  assertPublicDns,
  defaultClipsAllowedHosts,
  localSupabaseHttpOrigin,
  validateOutboundUrl,
} from "./validate-outbound-url";

afterEach(() => vi.unstubAllEnvs());

describe("validateOutboundUrl", () => {
  it.each([
    "https://user:password@example.com/video.mp4",
    "https://example.com:8443/video.mp4",
    "http://example.com/video.mp4",
    "https://127.0.0.1/video.mp4",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/video.mp4",
    "https://192.0.2.10/video.mp4",
  ])("rejette une URL sortante dangereuse: %s", (raw) => {
    expect(() => validateOutboundUrl(raw)).toThrow(OutboundUrlError);
  });

  it("accepte HTTPS public sur le port standard", () => {
    expect(validateOutboundUrl("https://example.com/video.mp4").hostname).toBe(
      "example.com",
    );
  });

  it("une allowlist vide refuse tout hôte", () => {
    expect(() =>
      validateOutboundUrl("https://example.com/video.mp4", {
        allowedHosts: [],
      }),
    ).toThrow(OutboundUrlError);
  });

  it("n'autorise que l'origine HTTP exacte de Supabase Docker local", () => {
    const allowHttpOrigin = "http://127.0.0.1:55321";
    expect(
      validateOutboundUrl(`${allowHttpOrigin}/storage/v1/object/sign/file`, {
        allowHttpOrigin,
      }).origin,
    ).toBe(allowHttpOrigin);
    expect(() =>
      validateOutboundUrl("http://127.0.0.1:54322/private", {
        allowHttpOrigin,
      }),
    ).toThrow(OutboundUrlError);
    expect(() =>
      validateOutboundUrl("http://169.254.169.254:54321/latest/meta-data", {
        allowHttpOrigin: "http://169.254.169.254:54321",
      }),
    ).toThrow(OutboundUrlError);
    expect(() =>
      validateOutboundUrl("http://127.0.0.1:54444/private", {
        allowHttpOrigin: "http://127.0.0.1:54444",
      }),
    ).toThrow(OutboundUrlError);
  });
});

describe("assertPublicDns", () => {
  it("refuse une résolution privée", async () => {
    await expect(
      assertPublicDns(new URL("https://cdn.example.com/file"), async () => [
        { address: "10.0.0.4", family: 4 },
      ]),
    ).rejects.toBeInstanceOf(OutboundUrlError);
  });

  it("refuse si une seule réponse DNS du lot est privée", async () => {
    await expect(
      assertPublicDns(new URL("https://cdn.example.com/file"), async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "fd00::1", family: 6 },
      ]),
    ).rejects.toBeInstanceOf(OutboundUrlError);
  });

  it("accepte uniquement un lot DNS entièrement public", async () => {
    await expect(
      assertPublicDns(new URL("https://cdn.example.com/file"), async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("defaultClipsAllowedHosts", () => {
  it("n'autorise que l'hôte du projet Supabase configuré", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    expect(defaultClipsAllowedHosts()).toEqual(["project-ref.supabase.co"]);
  });

  it("échoue fermé lorsque l'URL Supabase est absente ou invalide", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(defaultClipsAllowedHosts()).toEqual([]);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-url");
    expect(defaultClipsAllowedHosts()).toEqual([]);
  });
});

describe("localSupabaseHttpOrigin", () => {
  it("returns only the loopback Docker origin outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:55321");
    expect(localSupabaseHttpOrigin()).toBe("http://127.0.0.1:55321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://example.com:55321");
    expect(localSupabaseHttpOrigin()).toBeUndefined();
  });

  it("never enables the HTTP exception in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    expect(localSupabaseHttpOrigin()).toBeUndefined();
  });
});
