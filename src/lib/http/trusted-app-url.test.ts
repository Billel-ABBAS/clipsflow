import { afterEach, describe, expect, it, vi } from "vitest";
import { getTrustedAppUrl, safeRelativePath } from "./trusted-app-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTrustedAppUrl", () => {
  it("normalise une origine HTTPS configurée", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://clips.example.com/");

    expect(getTrustedAppUrl().href).toBe("https://clips.example.com/");
  });

  it("échoue fermé si l'origine de production manque", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    expect(() => getTrustedAppUrl()).toThrow("trusted_app_url:missing");
  });

  it.each([
    "http://clips.example.com",
    "https://user:pass@clips.example.com",
    "https://clips.example.com/base",
    "not-a-url",
  ])("rejette une origine de production non sûre: %s", (raw) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", raw);

    expect(() => getTrustedAppUrl()).toThrow("trusted_app_url:invalid");
  });

  it("autorise HTTP uniquement pour localhost en développement", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    expect(getTrustedAppUrl().href).toBe("http://localhost:3000/");

    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://clips.example.com");
    expect(() => getTrustedAppUrl()).toThrow("trusted_app_url:invalid");
  });
});

describe("safeRelativePath", () => {
  it.each(["/clips", "/fr/clips?tab=recent", "/pricing#plans"])(
    "conserve un chemin interne sûr: %s",
    (path) => {
      expect(safeRelativePath(path, "/clips")).toBe(path);
    },
  );

  it.each([
    "https://evil.example",
    "//evil.example/path",
    "/\\evil.example/path",
    "clips",
    "javascript:alert(1)",
    "/clips\r\nLocation:https://evil.example",
  ])("remplace une redirection non sûre: %s", (path) => {
    expect(safeRelativePath(path, "/clips")).toBe("/clips");
  });
});
