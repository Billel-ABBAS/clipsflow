import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  YouTubeTokenVaultError,
  decryptYouTubeRefreshToken,
  decryptYouTubeUploadSessionUri,
  encryptYouTubeRefreshToken,
  encryptYouTubeUploadSessionUri,
  getYouTubeTokenVaultKeyFromEnvironment,
  parseYouTubeTokenVaultKey,
} from "./token-vault";

const keyBase64 = Buffer.alloc(32, 7).toString("base64");
const anotherKeyBase64 = Buffer.alloc(32, 8).toString("base64");
const key = parseYouTubeTokenVaultKey(keyBase64);
const context = {
  userId: "44ab7c78-9f70-4d15-b3ec-4ddf2d3a1c90",
  connectionId: "8b32d29a-1bb0-4b41-bb23-d20d0d1450f9",
};
const refreshToken = "youtube-refresh-token-opaque-value";

function vaultErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(YouTubeTokenVaultError);
    return (error as YouTubeTokenVaultError).code;
  }
  throw new Error("expected a token vault error");
}

describe("YouTube refresh-token vault", () => {
  it("encrypts a versioned token and decrypts it for the exact same context", () => {
    const ciphertext = encryptYouTubeRefreshToken({
      refreshToken,
      context,
      key,
    });

    expect(ciphertext).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(ciphertext).not.toContain(refreshToken);
    expect(decryptYouTubeRefreshToken({ ciphertext, context, key })).toBe(
      refreshToken,
    );
  });

  it("seals resumable session URLs with a distinct purpose", () => {
    const uploadSessionUri =
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=opaque-id";
    const ciphertext = encryptYouTubeUploadSessionUri({
      uploadSessionUri,
      context,
      key,
    });
    expect(decryptYouTubeUploadSessionUri({ ciphertext, context, key })).toBe(
      uploadSessionUri,
    );
    expect(() =>
      decryptYouTubeRefreshToken({ ciphertext, context, key }),
    ).toThrow("youtube_token_vault:decrypt_failed");
    expect(() =>
      encryptYouTubeUploadSessionUri({
        uploadSessionUri: "https://evil.example/session",
        context,
        key,
      }),
    ).toThrow("youtube_token_vault:refresh_token_invalid");
  });

  it("authenticates the owner and connection through AES-GCM AAD", () => {
    const ciphertext = encryptYouTubeRefreshToken({
      refreshToken,
      context,
      key,
    });

    expect(
      vaultErrorCode(() =>
        decryptYouTubeRefreshToken({
          ciphertext,
          context: { ...context, userId: "another-user" },
          key,
        }),
      ),
    ).toBe("decrypt_failed");
    expect(
      vaultErrorCode(() =>
        decryptYouTubeRefreshToken({
          ciphertext,
          context: { ...context, connectionId: "another-connection" },
          key,
        }),
      ),
    ).toBe("decrypt_failed");
    expect(
      vaultErrorCode(() =>
        decryptYouTubeRefreshToken({
          ciphertext,
          context,
          key: parseYouTubeTokenVaultKey(anotherKeyBase64),
        }),
      ),
    ).toBe("decrypt_failed");
  });

  it("rejects altered and malformed sealed values without exposing the token", () => {
    const ciphertext = encryptYouTubeRefreshToken({
      refreshToken,
      context,
      key,
    });
    const parts = ciphertext.split(".");
    const encodedCiphertext = parts[2];
    if (!encodedCiphertext) throw new Error("missing encoded ciphertext");
    const altered = [
      parts[0],
      parts[1],
      `${encodedCiphertext.startsWith("A") ? "B" : "A"}${encodedCiphertext.slice(1)}`,
      parts[3],
    ].join(".");

    const alteredError = vaultErrorCode(() =>
      decryptYouTubeRefreshToken({ ciphertext: altered, context, key }),
    );
    expect(alteredError).toBe("decrypt_failed");
    expect(alteredError).not.toContain(refreshToken);
    expect(
      vaultErrorCode(() =>
        decryptYouTubeRefreshToken({
          ciphertext: "v2.not-valid.not-valid.not-valid",
          context,
          key,
        }),
      ),
    ).toBe("ciphertext_invalid");
  });
});

describe("YouTube token-vault key configuration", () => {
  it("accepts only a canonical 32-byte standard-base64 key", () => {
    expect(parseYouTubeTokenVaultKey(keyBase64)).toEqual(key);
    expect(vaultErrorCode(() => parseYouTubeTokenVaultKey(undefined))).toBe(
      "config_missing",
    );
    expect(
      vaultErrorCode(() =>
        parseYouTubeTokenVaultKey(randomBytes(31).toString("base64")),
      ),
    ).toBe("config_invalid");
    expect(
      vaultErrorCode(() => parseYouTubeTokenVaultKey(`${keyBase64}\n`)),
    ).toBe("config_invalid");
  });

  it("fails closed when a token-vault key was configured as NEXT_PUBLIC", () => {
    expect(
      getYouTubeTokenVaultKeyFromEnvironment({
        YOUTUBE_TOKEN_ENCRYPTION_KEY: keyBase64,
      }),
    ).toEqual(key);
    expect(
      vaultErrorCode(() =>
        getYouTubeTokenVaultKeyFromEnvironment({
          YOUTUBE_TOKEN_ENCRYPTION_KEY: keyBase64,
          NEXT_PUBLIC_YOUTUBE_TOKEN_ENCRYPTION_KEY: keyBase64,
        }),
      ),
    ).toBe("public_key_configured");
  });

  it("keeps invalid input errors free of token and key material", () => {
    const error = (() => {
      try {
        encryptYouTubeRefreshToken({
          refreshToken: "\u0000private-refresh-token",
          context,
          key,
        });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected a token vault error");
    })();

    expect(error.message).toBe("youtube_token_vault:refresh_token_invalid");
    expect(error.message).not.toContain("private-refresh-token");
    expect(error.message).not.toContain(keyBase64);
  });
});
