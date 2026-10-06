import {
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_REQUESTED_SCOPES,
  YOUTUBE_UPLOAD_SCOPE,
  type YouTubePublishRequestPayload,
} from "./oauth";

export const GOOGLE_OAUTH_TOKEN_URL =
  "https://oauth2.googleapis.com/token" as const;
export const YOUTUBE_CHANNELS_LIST_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=id%2Csnippet&mine=true&maxResults=50" as const;
export const YOUTUBE_UPLOAD_SESSION_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus" as const;

const PROVIDER_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_JSON_BYTES = 32 * 1024;
type FetchImplementation = typeof fetch;

export class YouTubeProviderError extends Error {
  constructor(
    public readonly code:
      | "oauth_exchange_failed"
      | "oauth_refresh_failed"
      | "oauth_scope_missing"
      | "oauth_token_invalid"
      | "channel_lookup_failed"
      | "channel_not_found"
      | "channel_ambiguous"
      | "channel_response_invalid"
      | "upload_session_create_failed"
      | "upload_session_uri_invalid"
      | "upload_session_expired"
      | "upload_status_failed"
      | "upload_response_invalid"
      | "upload_chunk_failed"
      | "upload_source_invalid",
    public readonly retryable = false,
  ) {
    super(`youtube_provider:${code}`);
    this.name = "YouTubeProviderError";
  }
}

function fail(
  code: ConstructorParameters<typeof YouTubeProviderError>[0],
  retryable = false,
): never {
  throw new YouTubeProviderError(code, retryable);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_PROVIDER_JSON_BYTES
  ) {
    fail("upload_response_invalid");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_JSON_BYTES) {
    fail("upload_response_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("upload_response_invalid");
  }
  const parsed = record(value);
  if (!parsed) fail("upload_response_invalid");
  return parsed;
}

function providerRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function oauthPost(
  body: URLSearchParams,
  fetchImplementation: FetchImplementation,
  failureCode: "oauth_exchange_failed" | "oauth_refresh_failed",
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImplementation(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    fail(failureCode, true);
  }
  if (!response.ok) fail(failureCode, providerRetryableStatus(response.status));
  try {
    return await readJsonObject(response);
  } catch {
    fail(failureCode);
  }
}

export type YouTubeOAuthTokens = Readonly<{
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  scopes: readonly [typeof YOUTUBE_UPLOAD_SCOPE, typeof YOUTUBE_READONLY_SCOPE];
}>;

function validateOAuthTokens(
  payload: Record<string, unknown>,
  requireRefreshToken: boolean,
): YouTubeOAuthTokens {
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  const scopes =
    typeof payload.scope === "string"
      ? payload.scope.split(/\s+/u).filter(Boolean)
      : [];
  const refreshToken = payload.refresh_token;
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 10 ||
    accessToken.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(accessToken) ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn < 60 ||
    expiresIn > 86_400 ||
    (requireRefreshToken &&
      (typeof refreshToken !== "string" ||
        refreshToken.length < 10 ||
        refreshToken.length > 8_192 ||
        /[\u0000-\u001f\u007f]/u.test(refreshToken)))
  ) {
    fail("oauth_token_invalid");
  }
  const grantedScopes = new Set(scopes);
  if (!YOUTUBE_REQUESTED_SCOPES.every((scope) => grantedScopes.has(scope))) {
    fail("oauth_scope_missing");
  }
  return {
    accessToken,
    expiresIn,
    refreshToken: typeof refreshToken === "string" ? refreshToken : null,
    scopes: YOUTUBE_REQUESTED_SCOPES,
  };
}

export async function exchangeYouTubeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetch?: FetchImplementation;
}): Promise<YouTubeOAuthTokens> {
  if (
    typeof input.code !== "string" ||
    input.code.length < 1 ||
    input.code.length > 4_096 ||
    typeof input.codeVerifier !== "string" ||
    input.codeVerifier.length < 43 ||
    input.codeVerifier.length > 128
  ) {
    fail("oauth_exchange_failed");
  }
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.codeVerifier,
  });
  const payload = await oauthPost(
    body,
    input.fetch ?? fetch,
    "oauth_exchange_failed",
  );
  return validateOAuthTokens(payload, false);
}

export async function refreshYouTubeAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: FetchImplementation;
}): Promise<{ accessToken: string; expiresIn: number }> {
  if (
    typeof input.refreshToken !== "string" ||
    input.refreshToken.length < 1 ||
    input.refreshToken.length > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(input.refreshToken)
  ) {
    fail("oauth_token_invalid");
  }
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: "refresh_token",
  });
  const payload = await oauthPost(
    body,
    input.fetch ?? fetch,
    "oauth_refresh_failed",
  );
  // Refresh grants commonly omit scope; the stored connection was checked on
  // the authorization-code grant and retains the original scopes.
  const tokens = validateOAuthTokens(
    { ...payload, scope: YOUTUBE_REQUESTED_SCOPES.join(" ") },
    false,
  );
  return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
}

export type YouTubeChannel = Readonly<{ id: string; title: string }>;

export async function getAuthorizedYouTubeChannel(input: {
  accessToken: string;
  fetch?: FetchImplementation;
}): Promise<YouTubeChannel> {
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(YOUTUBE_CHANNELS_LIST_URL, {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    fail("channel_lookup_failed", true);
  }
  if (!response.ok) {
    fail("channel_lookup_failed", providerRetryableStatus(response.status));
  }
  let payload: Record<string, unknown>;
  try {
    payload = await readJsonObject(response);
  } catch {
    fail("channel_response_invalid");
  }
  const items = payload.items;
  if (!Array.isArray(items)) fail("channel_response_invalid");
  if (items.length === 0) fail("channel_not_found");
  if (items.length !== 1) fail("channel_ambiguous");
  const item = record(items[0]);
  const snippet = record(item?.snippet);
  const id = item?.id;
  const title = snippet?.title;
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/u.test(id) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(title)
  ) {
    fail("channel_response_invalid");
  }
  return { id, title: title.trim() };
}

export function isValidYouTubeUploadSessionUri(
  value: unknown,
): value is string {
  if (typeof value !== "string" || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === "https://www.googleapis.com" &&
      url.pathname === "/upload/youtube/v3/videos" &&
      url.searchParams.get("uploadType") === "resumable" &&
      Boolean(url.searchParams.get("upload_id")) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function createYouTubeUploadSession(input: {
  accessToken: string;
  notifySubscribers?: boolean;
  payload: YouTubePublishRequestPayload["body"] & {
    status: YouTubePublishRequestPayload["body"]["status"] & {
      containsSyntheticMedia?: boolean;
    };
  };
  contentLength: number;
  fetch?: FetchImplementation;
}): Promise<string> {
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
    fail("upload_source_invalid");
  }
  let response: Response;
  try {
    const requestUrl = new URL(YOUTUBE_UPLOAD_SESSION_URL);
    requestUrl.searchParams.set(
      "notifySubscribers",
      String(input.notifySubscribers === true),
    );
    response = await (input.fetch ?? fetch)(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.contentLength),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(input.payload),
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    fail("upload_session_create_failed", true);
  }
  if (response.status < 200 || response.status >= 300) {
    fail(
      "upload_session_create_failed",
      providerRetryableStatus(response.status),
    );
  }
  const sessionUri = response.headers.get("location");
  if (!isValidYouTubeUploadSessionUri(sessionUri)) {
    fail("upload_session_uri_invalid");
  }
  return sessionUri;
}

export type YouTubeUploadProgress =
  | { kind: "incomplete"; nextOffset: number }
  | { kind: "complete"; videoId: string }
  | { kind: "expired" };

function parseIncompleteOffset(
  response: Response,
  contentLength: number,
): number {
  const range = response.headers.get("range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(range);
  if (!match) fail("upload_response_invalid");
  const nextOffset = Number(match[1]) + 1;
  if (
    !Number.isSafeInteger(nextOffset) ||
    nextOffset < 0 ||
    nextOffset > contentLength
  ) {
    fail("upload_response_invalid");
  }
  return nextOffset;
}

async function parseCompletedUpload(
  response: Response,
): Promise<{ kind: "complete"; videoId: string }> {
  const payload = await readJsonObject(response);
  if (
    typeof payload.id !== "string" ||
    !/^[A-Za-z0-9_-]{6,128}$/u.test(payload.id)
  ) {
    fail("upload_response_invalid");
  }
  return { kind: "complete", videoId: payload.id };
}

export async function checkYouTubeUploadSession(input: {
  accessToken: string;
  sessionUri: string;
  contentLength: number;
  fetch?: FetchImplementation;
}): Promise<YouTubeUploadProgress> {
  if (
    !isValidYouTubeUploadSessionUri(input.sessionUri) ||
    !Number.isSafeInteger(input.contentLength) ||
    input.contentLength < 1
  ) {
    fail("upload_session_uri_invalid");
  }
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(input.sessionUri, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Length": "0",
        "Content-Range": `bytes */${input.contentLength}`,
      },
      body: new Uint8Array(),
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    fail("upload_status_failed", true);
  }
  if (response.status === 404 || response.status === 410)
    return { kind: "expired" };
  if (response.status === 308) {
    return {
      kind: "incomplete",
      nextOffset: parseIncompleteOffset(response, input.contentLength),
    };
  }
  if (response.status === 200 || response.status === 201) {
    return parseCompletedUpload(response);
  }
  fail("upload_status_failed", providerRetryableStatus(response.status));
}

export async function uploadYouTubeChunk(input: {
  accessToken: string;
  sessionUri: string;
  contentLength: number;
  startOffset: number;
  bytes: Uint8Array;
  fetch?: FetchImplementation;
}): Promise<Exclude<YouTubeUploadProgress, { kind: "expired" }>> {
  const endOffset = input.startOffset + input.bytes.byteLength;
  if (
    !isValidYouTubeUploadSessionUri(input.sessionUri) ||
    !Number.isSafeInteger(input.contentLength) ||
    !Number.isSafeInteger(input.startOffset) ||
    input.startOffset < 0 ||
    input.bytes.byteLength < 1 ||
    endOffset > input.contentLength
  ) {
    fail("upload_source_invalid");
  }
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(input.sessionUri, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Length": String(input.bytes.byteLength),
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${input.startOffset}-${endOffset - 1}/${input.contentLength}`,
      },
      // Node's fetch accepts Uint8Array bodies; the DOM BodyInit declaration
      // in this TS configuration is narrower than the runtime implementation.
      body: input.bytes as unknown as BodyInit,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    fail("upload_chunk_failed", true);
  }
  if (response.status === 308) {
    return {
      kind: "incomplete",
      nextOffset: parseIncompleteOffset(response, input.contentLength),
    };
  }
  if (response.status === 200 || response.status === 201) {
    return parseCompletedUpload(response);
  }
  fail("upload_chunk_failed", providerRetryableStatus(response.status));
}
