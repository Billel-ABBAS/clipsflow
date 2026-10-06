export type YouTubeOAuthFeedback = "connected" | "cancelled" | "error";

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) return item.trim();
    }
  }
  return null;
}

/** Map OAuth query state to safe, user-facing statuses without exposing errors. */
export function resolveYouTubeOAuthFeedback(
  searchParams: SearchParams,
): YouTubeOAuthFeedback | null {
  const error = firstValue(searchParams.youtube_error);
  if (error) return error === "cancelled" ? "cancelled" : "error";

  return firstValue(searchParams.youtube) === "connected" ? "connected" : null;
}
