export const YOUTUBE_OAUTH_COOKIE = "clipsflow_youtube_oauth";
export const YOUTUBE_OAUTH_COOKIE_PATH = "/api/youtube/oauth";

export type PendingYouTubeOAuth = Readonly<{
  state: string;
  codeVerifier: string;
  userId: string;
  issuedAt: number;
  returnPath: string;
}>;

const MAX_COOKIE_VALUE_LENGTH = 8_192;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodePendingYouTubeOAuth(value: PendingYouTubeOAuth): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function parsePendingYouTubeOAuth(
  value: string | undefined,
): PendingYouTubeOAuth | null {
  if (
    !value ||
    value.length > MAX_COOKIE_VALUE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value)
      return null;
    const candidate: unknown = JSON.parse(decoded);
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.state !== "string" ||
      row.state.length === 0 ||
      row.state.length > 2_048 ||
      typeof row.codeVerifier !== "string" ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(row.codeVerifier) ||
      typeof row.userId !== "string" ||
      !UUID_RE.test(row.userId) ||
      typeof row.returnPath !== "string" ||
      row.returnPath.length === 0 ||
      row.returnPath.length > 2_048 ||
      !Number.isSafeInteger(row.issuedAt)
    ) {
      return null;
    }
    return {
      state: row.state,
      codeVerifier: row.codeVerifier,
      userId: row.userId,
      issuedAt: row.issuedAt as number,
      returnPath: row.returnPath,
    };
  } catch {
    return null;
  }
}
