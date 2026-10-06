// ============================================================================
// ClipsFlow — coffre de refresh tokens YouTube (SERVER ONLY)
// ============================================================================
// Les routes serveur doivent chiffrer le refresh token avant toute persistance
// et le dechiffrer uniquement juste avant un appel OAuth YouTube. Ce module ne
// fait ni reseau ni I/O de base de donnees. Ne jamais l'importer dans un
// composant client et ne jamais journaliser un token, chiffre ou non.
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const YOUTUBE_TOKEN_VAULT_VERSION = "v1";

const KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const MAX_REFRESH_TOKEN_BYTES = 8 * 1024;
const MAX_SEALED_TOKEN_LENGTH = 16 * 1024;
const BASE64_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_URL_RE = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export type YouTubeTokenVaultContext = Readonly<{
  /** Stable authenticated owner ID. It is authenticated additional data. */
  userId: string;
  /** Stable YouTube connection ID. It is authenticated additional data. */
  connectionId: string;
  /** Domain separation prevents a stored upload URL being read as a token. */
  purpose?: "refresh_token" | "upload_session_uri";
}>;

export type YouTubeTokenVaultErrorCode =
  | "config_missing"
  | "config_invalid"
  | "public_key_configured"
  | "context_invalid"
  | "refresh_token_invalid"
  | "ciphertext_invalid"
  | "decrypt_failed";

/**
 * A deliberately terse error. Its message and fields never include a key,
 * refresh token, ciphertext, or lower-level crypto error.
 */
export class YouTubeTokenVaultError extends Error {
  readonly code: YouTubeTokenVaultErrorCode;

  constructor(code: YouTubeTokenVaultErrorCode) {
    super(`youtube_token_vault:${code}`);
    this.name = "YouTubeTokenVaultError";
    this.code = code;
  }
}

function fail(code: YouTubeTokenVaultErrorCode): never {
  throw new YouTubeTokenVaultError(code);
}

function assertContextValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    fail("context_invalid");
  }
}

function assertContext(
  context: YouTubeTokenVaultContext,
): asserts context is YouTubeTokenVaultContext {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    fail("context_invalid");
  }
  assertContextValue(context.userId);
  assertContextValue(context.connectionId);
}

function contextAad(context: YouTubeTokenVaultContext): Buffer {
  assertContext(context);
  // JSON, instead of concatenating IDs with a separator, avoids ambiguous AAD
  // encodings when future ID formats legitimately contain punctuation.
  return Buffer.from(
    JSON.stringify({
      version: YOUTUBE_TOKEN_VAULT_VERSION,
      userId: context.userId,
      connectionId: context.connectionId,
      purpose: context.purpose ?? "refresh_token",
    }),
    "utf8",
  );
}

function assertRefreshToken(value: unknown): asserts value is string {
  if (typeof value !== "string") fail("refresh_token_invalid");
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < 1 ||
    bytes > MAX_REFRESH_TOKEN_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("refresh_token_invalid");
  }
}

function assertUploadSessionUri(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192) {
    fail("refresh_token_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("refresh_token_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://www.googleapis.com" ||
    url.pathname !== "/upload/youtube/v3/videos" ||
    url.searchParams.get("uploadType") !== "resumable" ||
    !url.searchParams.get("upload_id") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    fail("refresh_token_invalid");
  }
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!BASE64_URL_RE.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

type ParsedSealedRefreshToken = Readonly<{
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}>;

function parseSealedRefreshToken(value: unknown): ParsedSealedRefreshToken {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SEALED_TOKEN_LENGTH
  ) {
    return fail("ciphertext_invalid");
  }

  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== YOUTUBE_TOKEN_VAULT_VERSION) {
    return fail("ciphertext_invalid");
  }
  const [, encodedIv, encodedCiphertext, encodedAuthTag] = parts;
  if (!encodedIv || !encodedCiphertext || !encodedAuthTag) {
    return fail("ciphertext_invalid");
  }

  const iv = decodeCanonicalBase64Url(encodedIv);
  const ciphertext = decodeCanonicalBase64Url(encodedCiphertext);
  const authTag = decodeCanonicalBase64Url(encodedAuthTag);
  if (
    !iv ||
    !ciphertext ||
    !authTag ||
    iv.length !== GCM_IV_BYTES ||
    authTag.length !== GCM_AUTH_TAG_BYTES ||
    ciphertext.length < 1 ||
    ciphertext.length > MAX_REFRESH_TOKEN_BYTES
  ) {
    return fail("ciphertext_invalid");
  }

  return Object.freeze({ iv, ciphertext, authTag });
}

/**
 * Parse a canonical standard-base64 32-byte AES-256 key. The raw value is
 * passed explicitly so encryption/decryption remain pure and straightforward
 * to test. Values are never included in the thrown error.
 */
export function parseYouTubeTokenVaultKey(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    return fail("config_missing");
  }
  if (!BASE64_KEY_RE.test(value)) return fail("config_invalid");

  let key: Buffer;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    return fail("config_invalid");
  }
  if (key.length !== KEY_BYTES || key.toString("base64") !== value) {
    return fail("config_invalid");
  }
  return key;
}

/**
 * Server-only environment wrapper. A public variable with a token-vault key
 * is always unsafe, even when the private variable is also present.
 */
export function getYouTubeTokenVaultKeyFromEnvironment(
  environment: ServerEnvironment = process.env,
): Buffer {
  if (
    environment.NEXT_PUBLIC_YOUTUBE_TOKEN_ENCRYPTION_KEY ||
    environment.NEXT_PUBLIC_YOUTUBE_TOKEN_VAULT_KEY
  ) {
    return fail("public_key_configured");
  }
  return parseYouTubeTokenVaultKey(environment.YOUTUBE_TOKEN_ENCRYPTION_KEY);
}

/**
 * Seal a refresh token using AES-256-GCM. The authenticated additional data
 * binds the ciphertext to exactly one owner and one YouTube connection.
 */
export function encryptYouTubeRefreshToken(input: {
  refreshToken: string;
  context: YouTubeTokenVaultContext;
  key: Buffer;
}): string {
  assertRefreshToken(input?.refreshToken);
  assertContext(input?.context);
  if (!Buffer.isBuffer(input?.key) || input.key.length !== KEY_BYTES) {
    return fail("config_invalid");
  }

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(contextAad(input.context));
  const ciphertext = Buffer.concat([
    cipher.update(input.refreshToken, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    YOUTUBE_TOKEN_VAULT_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(".");
}

/** Seal a short-lived YouTube resumable upload URL in the same server vault. */
export function encryptYouTubeUploadSessionUri(input: {
  uploadSessionUri: string;
  context: Omit<YouTubeTokenVaultContext, "purpose">;
  key: Buffer;
}): string {
  assertUploadSessionUri(input?.uploadSessionUri);
  const context: YouTubeTokenVaultContext = {
    ...input.context,
    purpose: "upload_session_uri",
  };
  assertContext(context);
  if (!Buffer.isBuffer(input?.key) || input.key.length !== KEY_BYTES) {
    return fail("config_invalid");
  }

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(contextAad(context));
  const ciphertext = Buffer.concat([
    cipher.update(input.uploadSessionUri, "utf8"),
    cipher.final(),
  ]);
  return [
    YOUTUBE_TOKEN_VAULT_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

/**
 * Open a token previously created by `encryptYouTubeRefreshToken`. Any key,
 * context, or ciphertext authentication failure produces the same generic
 * error so callers cannot use it as an oracle.
 */
export function decryptYouTubeRefreshToken(input: {
  ciphertext: string;
  context: YouTubeTokenVaultContext;
  key: Buffer;
}): string {
  assertContext(input?.context);
  if (!Buffer.isBuffer(input?.key) || input.key.length !== KEY_BYTES) {
    return fail("config_invalid");
  }

  const sealed = parseSealedRefreshToken(input?.ciphertext);
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.key, sealed.iv);
    decipher.setAAD(contextAad(input.context));
    decipher.setAuthTag(sealed.authTag);
    const refreshToken = Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    assertRefreshToken(refreshToken);
    return refreshToken;
  } catch (error) {
    // Do not preserve `error` as a cause: crypto errors may contain provider
    // details and callers must never receive information about secret values.
    if (error instanceof YouTubeTokenVaultError) throw error;
    return fail("decrypt_failed");
  }
}

/** Open an upload session URL only for the exact owner and connection. */
export function decryptYouTubeUploadSessionUri(input: {
  ciphertext: string;
  context: Omit<YouTubeTokenVaultContext, "purpose">;
  key: Buffer;
}): string {
  const context: YouTubeTokenVaultContext = {
    ...input.context,
    purpose: "upload_session_uri",
  };
  assertContext(context);
  if (!Buffer.isBuffer(input?.key) || input.key.length !== KEY_BYTES) {
    return fail("config_invalid");
  }

  const sealed = parseSealedRefreshToken(input?.ciphertext);
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.key, sealed.iv);
    decipher.setAAD(contextAad(context));
    decipher.setAuthTag(sealed.authTag);
    const uploadSessionUri = Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    assertUploadSessionUri(uploadSessionUri);
    return uploadSessionUri;
  } catch (error) {
    if (error instanceof YouTubeTokenVaultError) throw error;
    return fail("decrypt_failed");
  }
}
