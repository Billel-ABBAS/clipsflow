// ============================================================================
// ClipsFlow Shorts — bounded source upload contract
// ============================================================================

import { z } from "zod";

export const SHORTS_SOURCE_BUCKET = "clip-sources" as const;
export const SHORTS_SOURCE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const SHORTS_SOURCE_MIN_BYTES = 1;
export const SHORTS_TUS_CHUNK_BYTES = 6 * 1024 * 1024;
export const SHORTS_TUS_RETRY_DELAYS_MS = [0, 3_000, 5_000, 10_000, 20_000];

export const SHORTS_SOURCE_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
] as const;
const SHORTS_EXTENSION_MIME_TYPES: Readonly<
  Record<string, (typeof SHORTS_SOURCE_MIME_TYPES)[number]>
> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

export function resolveShortsSourceMime(
  mime: string,
  fileName: string,
): (typeof SHORTS_SOURCE_MIME_TYPES)[number] | null {
  if ((SHORTS_SOURCE_MIME_TYPES as readonly string[]).includes(mime)) {
    return mime as (typeof SHORTS_SOURCE_MIME_TYPES)[number];
  }
  if (mime !== "" && mime !== "application/octet-stream") return null;
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  return SHORTS_EXTENSION_MIME_TYPES[extension] ?? null;
}

export const shortsSourceUploadInitSchema = z.strictObject({
  file_name: z.string().trim().min(1).max(180),
  mime: z.enum(SHORTS_SOURCE_MIME_TYPES),
  size_bytes: z
    .number()
    .int()
    .min(SHORTS_SOURCE_MIN_BYTES)
    .max(SHORTS_SOURCE_MAX_BYTES),
  title: z.string().trim().min(1).max(200),
});

export const shortsSourceUploadCompleteSchema = z.strictObject({
  size_bytes: z
    .number()
    .int()
    .min(SHORTS_SOURCE_MIN_BYTES)
    .max(SHORTS_SOURCE_MAX_BYTES),
});

/**
 * Keep the worker limit at or below the amount the browser may upload. A
 * smaller worker-specific value is allowed for staging/limited disks.
 */
export function resolveShortsSourceMaxBytes(rawValue?: string): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return SHORTS_SOURCE_MAX_BYTES;
  }
  const value = Number(rawValue);
  return Number.isSafeInteger(value) &&
    value >= 50 * 1024 * 1024 &&
    value <= SHORTS_SOURCE_MAX_BYTES
    ? value
    : SHORTS_SOURCE_MAX_BYTES;
}

/**
 * Build the Storage TUS endpoint. Supabase's direct Storage hostname avoids
 * proxying multi-gigabyte uploads through the project API hostname. Local
 * Supabase and explicitly configured custom domains remain unchanged.
 */
export function getShortsTusEndpoint(supabaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(supabaseUrl);
  } catch {
    return null;
  }

  const isLocalHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return null;
  }

  if (
    url.hostname.endsWith(".supabase.co") &&
    !url.hostname.endsWith(".storage.supabase.co")
  ) {
    url.hostname = url.hostname.replace(
      /\.supabase\.co$/u,
      ".storage.supabase.co",
    );
  }
  url.pathname = "/storage/v1/upload/resumable";
  return url.toString();
}

export type ShortsTusConfig = Readonly<{
  endpoint: string;
  bucket: typeof SHORTS_SOURCE_BUCKET;
  storagePath: string;
  contentType: (typeof SHORTS_SOURCE_MIME_TYPES)[number];
  uploadToken: string;
  accessToken: string;
  apiKey: string;
  fingerprint: string;
}>;

export function buildShortsTusOptions(config: ShortsTusConfig) {
  return {
    endpoint: config.endpoint,
    chunkSize: SHORTS_TUS_CHUNK_BYTES,
    retryDelays: [...SHORTS_TUS_RETRY_DELAYS_MS],
    uploadDataDuringCreation: true,
    removeFingerprintOnSuccess: true,
    storeFingerprintForResuming: true,
    fingerprint: async () => `clipsflow-shorts:${config.fingerprint}`,
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      apikey: config.apiKey,
      "x-signature": config.uploadToken,
    },
    metadata: {
      bucketName: config.bucket,
      objectName: config.storagePath,
      contentType: config.contentType,
      cacheControl: "3600",
    },
  };
}
