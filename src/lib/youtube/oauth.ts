// ============================================================================
// ClipsFlow — helpers OAuth et publication YouTube (SERVER ONLY)
// ============================================================================
// Cette couche ne réalise volontairement aucun appel HTTP et ne persiste aucun
// jeton. Une future route serveur doit conserver `state` et `codeVerifier`
// dans une session serveur / un cookie HttpOnly, puis les supprimer après le
// callback. Ne jamais importer ce module depuis un composant client.
// ============================================================================

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Upload plus affichage en lecture seule du nom/ID du canal connecté. */
export const YOUTUBE_UPLOAD_SCOPE =
  "https://www.googleapis.com/auth/youtube.upload";
export const YOUTUBE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/youtube.readonly";
export const YOUTUBE_REQUESTED_SCOPES = [
  YOUTUBE_UPLOAD_SCOPE,
  YOUTUBE_READONLY_SCOPE,
] as const;

export const YOUTUBE_OAUTH_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";

export const DEFAULT_YOUTUBE_RETURN_PATH = "/clips";
export const DEFAULT_YOUTUBE_STATE_MAX_AGE_MS = 10 * 60 * 1000;

const STATE_VERSION = 1;
const BASE64_URL_RE = /^[A-Za-z0-9_-]+$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

export type YouTubeOAuthConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
}>;

export type YouTubeOAuthConfigOptions = Readonly<{
  /** Explicit opt-in reserved for an HTTP localhost development callback. */
  allowHttpLocalhost?: boolean;
}>;

export type YouTubeOAuthAuthorizationRequest = Readonly<{
  authorizationUrl: string;
  codeVerifier: string;
  state: string;
  expiresAt: number;
}>;

export type ValidatedYouTubeOAuthState = Readonly<{
  nonce: string;
  returnPath: string;
  issuedAt: number;
}>;

export type YouTubePublishPrivacyStatus = "private" | "unlisted" | "public";

export type YouTubePublishInput = Readonly<{
  title: string;
  description?: string | null;
  tags?: readonly string[];
  privacyStatus?: YouTubePublishPrivacyStatus;
  /** Required when, and only when, a caller intentionally asks for public. */
  confirmPublic?: boolean;
  /** Defaults to false so a background upload cannot notify subscribers. */
  notifySubscribers?: boolean;
  /** Omitted until the product explicitly collects this legal declaration. */
  madeForKids?: boolean;
}>;

export type YouTubePublishRequestPayload = Readonly<{
  part: readonly ["snippet", "status"];
  notifySubscribers: boolean;
  body: {
    snippet: {
      title: string;
      description: string;
      tags?: string[];
    };
    status: {
      privacyStatus: YouTubePublishPrivacyStatus;
      selfDeclaredMadeForKids?: boolean;
    };
  };
}>;

type OAuthStatePayload = Readonly<{
  v: number;
  nonce: string;
  returnPath: string;
  issuedAt: number;
}>;

function configError(code: string): never {
  throw new Error(`youtube_oauth:${code}`);
}

function publishError(code: string): never {
  throw new Error(`youtube_publish:${code}`);
}

function requiredConfigValue(
  environment: ServerEnvironment,
  key: string,
): string {
  const raw = environment[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) configError("config_missing");
  return value;
}

function isSafeInternalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\u0000-\u001f\u007f]/.test(value) &&
    !/%(?:2f|5c)/i.test(value)
  );
}

function validateRedirectUri(
  value: string,
  allowHttpLocalhost: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configError("redirect_uri_invalid");
  }

  const localHttp =
    allowHttpLocalhost &&
    url.protocol === "http:" &&
    LOCAL_HTTP_HOSTS.has(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/") ||
    /(?:^|\/)\.\.?($|\/)/.test(url.pathname) ||
    /%(?:2e|2f|5c)/i.test(url.pathname)
  ) {
    return configError("redirect_uri_invalid");
  }

  return value;
}

function assertStateSecret(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 32) {
    configError("state_secret_too_short");
  }
}

function assertTimestamp(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    configError("state_invalid");
  }
}

function assertPkceCodeVerifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PKCE_VERIFIER_RE.test(value)) {
    configError("pkce_verifier_invalid");
  }
}

function constantTimeEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function signState(encodedPayload: string, stateSecret: string): string {
  return createHmac("sha256", stateSecret)
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

function encodeStatePayload(payload: OAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeStatePayload(encodedPayload: string): OAuthStatePayload {
  if (!BASE64_URL_RE.test(encodedPayload)) configError("state_invalid");

  let candidate: unknown;
  try {
    candidate = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
  } catch {
    return configError("state_invalid");
  }

  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (candidate as Record<string, unknown>).v !== STATE_VERSION ||
    typeof (candidate as Record<string, unknown>).nonce !== "string" ||
    typeof (candidate as Record<string, unknown>).returnPath !== "string" ||
    !Number.isSafeInteger((candidate as Record<string, unknown>).issuedAt)
  ) {
    return configError("state_invalid");
  }

  const payload = candidate as OAuthStatePayload;
  if (
    typeof payload.nonce !== "string" ||
    !BASE64_URL_RE.test(payload.nonce) ||
    payload.nonce.length < 32
  ) {
    return configError("state_invalid");
  }
  if (safeYouTubeOAuthReturnPath(payload.returnPath) !== payload.returnPath) {
    return configError("state_invalid");
  }
  assertTimestamp(payload.issuedAt);
  return payload;
}

function parseSignedState(
  state: string,
  stateSecret: string,
): OAuthStatePayload {
  assertStateSecret(stateSecret);
  const parts = state.split(".");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !BASE64_URL_RE.test(parts[1])
  ) {
    return configError("state_invalid");
  }

  const [encodedPayload, signature] = parts as [string, string];
  const expectedSignature = signState(encodedPayload, stateSecret);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return configError("state_invalid");
  }
  return decodeStatePayload(encodedPayload);
}

function hasForbiddenControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Reads only non-public environment names. Call from a route, never a client
 * component. The explicit public-secret check catches a dangerous deployment
 * configuration before an OAuth flow starts.
 */
export function parseYouTubeOAuthConfig(
  environment: ServerEnvironment,
  options: YouTubeOAuthConfigOptions = {},
): YouTubeOAuthConfig {
  if (
    environment.NEXT_PUBLIC_YOUTUBE_OAUTH_CLIENT_SECRET ||
    environment.NEXT_PUBLIC_YOUTUBE_OAUTH_STATE_SECRET
  ) {
    return configError("public_secret_configured");
  }

  const clientId = requiredConfigValue(environment, "YOUTUBE_OAUTH_CLIENT_ID");
  const clientSecret = requiredConfigValue(
    environment,
    "YOUTUBE_OAUTH_CLIENT_SECRET",
  );
  const stateSecret = requiredConfigValue(
    environment,
    "YOUTUBE_OAUTH_STATE_SECRET",
  );
  assertStateSecret(stateSecret);
  const redirectUri = validateRedirectUri(
    requiredConfigValue(environment, "YOUTUBE_OAUTH_REDIRECT_URI"),
    options.allowHttpLocalhost === true,
  );

  return Object.freeze({ clientId, clientSecret, redirectUri, stateSecret });
}

/** Server convenience wrapper; tests and integrations can pass a fixed env. */
export function getYouTubeOAuthConfig(
  environment: ServerEnvironment = process.env,
  options: YouTubeOAuthConfigOptions = {},
): YouTubeOAuthConfig {
  return parseYouTubeOAuthConfig(environment, options);
}

/**
 * Preserve only a same-origin relative path. This is deliberately separate
 * from general URL parsing so a callback cannot become an open redirect.
 */
export function safeYouTubeOAuthReturnPath(
  raw: string | null | undefined,
  fallback = DEFAULT_YOUTUBE_RETURN_PATH,
): string {
  if (!isSafeInternalPath(fallback))
    configError("return_path_fallback_invalid");
  if (!raw || !isSafeInternalPath(raw)) return fallback;
  return raw;
}

/** RFC 7636 S256 transformation; deterministic and safe to unit-test. */
export function createPkceCodeChallenge(codeVerifier: string): string {
  assertPkceCodeVerifier(codeVerifier);
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

/**
 * Builds a signed, short-lived state value. The nonce must come from a
 * cryptographically secure source; `createYouTubeOAuthAuthorizationRequest`
 * provides one for ordinary server use.
 */
export function createYouTubeOAuthState(input: {
  stateSecret: string;
  nonce: string;
  returnPath?: string | null;
  fallbackReturnPath?: string;
  issuedAt: number;
}): string {
  assertStateSecret(input.stateSecret);
  if (
    typeof input.nonce !== "string" ||
    !BASE64_URL_RE.test(input.nonce) ||
    input.nonce.length < 32
  ) {
    return configError("state_nonce_invalid");
  }
  assertTimestamp(input.issuedAt);

  const payload: OAuthStatePayload = {
    v: STATE_VERSION,
    nonce: input.nonce,
    returnPath: safeYouTubeOAuthReturnPath(
      input.returnPath,
      input.fallbackReturnPath ?? DEFAULT_YOUTUBE_RETURN_PATH,
    ),
    issuedAt: input.issuedAt,
  };
  const encodedPayload = encodeStatePayload(payload);
  return `${encodedPayload}.${signState(encodedPayload, input.stateSecret)}`;
}

/** Build the exact Google authorization URL without making a network call. */
export function buildYouTubeOAuthAuthorizationUrl(input: {
  config: YouTubeOAuthConfig;
  state: string;
  codeVerifier: string;
}): string {
  assertPkceCodeVerifier(input.codeVerifier);
  if (
    typeof input.state !== "string" ||
    !input.state ||
    input.state.length > 2048
  ) {
    configError("state_invalid");
  }

  const url = new URL(YOUTUBE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("response_type", "code");
  // Read-only access is used solely to identify the channel before a
  // publication. No channel-management/write scope is requested.
  url.searchParams.set("scope", YOUTUBE_REQUESTED_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set(
    "code_challenge",
    createPkceCodeChallenge(input.codeVerifier),
  );
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Convenient server-side composition around the pure primitives above. The
 * caller must store the resulting verifier and state in an HttpOnly session.
 */
export function createYouTubeOAuthAuthorizationRequest(input: {
  config: YouTubeOAuthConfig;
  returnPath?: string | null;
  fallbackReturnPath?: string;
  issuedAt?: number;
  nonce?: string;
  codeVerifier?: string;
  stateMaxAgeMs?: number;
}): YouTubeOAuthAuthorizationRequest {
  const issuedAt = input.issuedAt ?? Date.now();
  assertTimestamp(issuedAt);
  const stateMaxAgeMs = input.stateMaxAgeMs ?? DEFAULT_YOUTUBE_STATE_MAX_AGE_MS;
  if (!Number.isSafeInteger(stateMaxAgeMs) || stateMaxAgeMs <= 0) {
    return configError("state_max_age_invalid");
  }

  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  const codeVerifier =
    input.codeVerifier ?? randomBytes(64).toString("base64url");
  const state = createYouTubeOAuthState({
    stateSecret: input.config.stateSecret,
    nonce,
    returnPath: input.returnPath,
    fallbackReturnPath: input.fallbackReturnPath,
    issuedAt,
  });

  return {
    authorizationUrl: buildYouTubeOAuthAuthorizationUrl({
      config: input.config,
      state,
      codeVerifier,
    }),
    codeVerifier,
    state,
    expiresAt: issuedAt + stateMaxAgeMs,
  };
}

/**
 * Validates both the signed Google callback state and the exact state saved in
 * the initiating browser's server-side session. Requiring both prevents a
 * valid state from another session from acting as a CSRF bypass.
 */
export function validateYouTubeOAuthCallbackState(input: {
  receivedState: string | null | undefined;
  expectedState: string | null | undefined;
  stateSecret: string;
  now?: number;
  maxAgeMs?: number;
}): ValidatedYouTubeOAuthState {
  if (
    typeof input.receivedState !== "string" ||
    typeof input.expectedState !== "string" ||
    !input.receivedState ||
    !input.expectedState
  ) {
    return configError("state_missing");
  }
  if (!constantTimeEqual(input.receivedState, input.expectedState)) {
    return configError("state_mismatch");
  }

  const payload = parseSignedState(input.receivedState, input.stateSecret);
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_YOUTUBE_STATE_MAX_AGE_MS;
  assertTimestamp(now);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    return configError("state_max_age_invalid");
  }
  if (payload.issuedAt > now || now - payload.issuedAt > maxAgeMs) {
    return configError("state_expired");
  }

  return Object.freeze({
    nonce: payload.nonce,
    returnPath: payload.returnPath,
    issuedAt: payload.issuedAt,
  });
}

/**
 * Produces the body/parameters for a future `videos.insert` call. It never
 * makes that call. A public upload is refused unless a higher layer passes an
 * explicit confirmation; private is the safe default and subscriber alerts
 * are opt-in.
 */
export function buildYouTubePublishRequestPayload(
  input: YouTubePublishInput,
): YouTubePublishRequestPayload {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 100 || hasForbiddenControlCharacter(title)) {
    return publishError("title_invalid");
  }

  if (input.description != null && typeof input.description !== "string") {
    return publishError("description_invalid");
  }
  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > 5000 || hasForbiddenControlCharacter(description)) {
    return publishError("description_invalid");
  }

  const requestedPrivacy = input.privacyStatus ?? "private";
  if (
    requestedPrivacy !== "private" &&
    requestedPrivacy !== "unlisted" &&
    requestedPrivacy !== "public"
  ) {
    return publishError("privacy_invalid");
  }
  if (requestedPrivacy === "public" && input.confirmPublic !== true) {
    return publishError("public_confirmation_required");
  }
  const privacyStatus: YouTubePublishPrivacyStatus =
    requestedPrivacy === "unlisted"
      ? "unlisted"
      : requestedPrivacy === "public"
        ? "public"
        : "private";

  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    return publishError("tags_invalid");
  }
  const tags = input.tags
    ?.map((tag) => {
      if (typeof tag !== "string") return publishError("tags_invalid");
      return tag.trim();
    })
    .filter((tag) => tag.length > 0);
  if (
    tags?.some(
      (tag) => tag.length > 100 || hasForbiddenControlCharacter(tag),
    ) ||
    (tags?.length ?? 0) > 30
  ) {
    return publishError("tags_invalid");
  }
  const uniqueTags = tags ? [...new Set(tags)] : undefined;

  const status: YouTubePublishRequestPayload["body"]["status"] = {
    privacyStatus,
  };
  if (typeof input.madeForKids === "boolean") {
    status.selfDeclaredMadeForKids = input.madeForKids;
  }

  return {
    part: ["snippet", "status"],
    // A product decision to notify subscribers must be explicit.
    notifySubscribers: input.notifySubscribers === true,
    body: {
      snippet: {
        title,
        description,
        ...(uniqueTags && uniqueTags.length > 0 ? { tags: uniqueTags } : {}),
      },
      status,
    },
  };
}
