// ============================================================================
// ClipsFlow Shorts — non-secret metadata for restoring interrupted browser uploads
// ============================================================================

import { z } from "zod";

export const SHORTS_PENDING_SOURCE_UPLOADS_KEY =
  "clipsflow:shorts:pending-source-uploads:v1";
export const SHORTS_PENDING_SOURCE_UPLOADS_MAX = 5;
export const SHORTS_PENDING_SOURCE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const pendingUploadSchema = z.strictObject({
  episodeId: z.uuid(),
  filename: z.string().min(1).max(180),
  fileSizeBytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024 * 1024),
  lastModifiedMs: z.number().int().min(0),
  title: z.string().trim().min(1).max(200),
  savedAtMs: z.number().int().positive(),
});

const pendingUploadListSchema = z.strictObject({
  version: z.literal(1),
  uploads: z.array(pendingUploadSchema).max(SHORTS_PENDING_SOURCE_UPLOADS_MAX),
});

export type PendingShortsSourceUpload = z.infer<typeof pendingUploadSchema>;

export function parsePendingShortsSourceUploads(
  value: unknown,
  nowMs = Date.now(),
): PendingShortsSourceUpload[] {
  const parsed = pendingUploadListSchema.safeParse(value);
  if (!parsed.success) return [];

  return parsed.data.uploads.filter(
    (upload) =>
      upload.savedAtMs <= nowMs + 5 * 60 * 1_000 &&
      nowMs - upload.savedAtMs <= SHORTS_PENDING_SOURCE_UPLOAD_MAX_AGE_MS,
  );
}

export function serialisePendingShortsSourceUploads(
  uploads: readonly PendingShortsSourceUpload[],
  nowMs = Date.now(),
): string {
  const unique = new Map<string, PendingShortsSourceUpload>();
  for (const upload of uploads) {
    const parsed = pendingUploadSchema.safeParse(upload);
    if (!parsed.success) continue;
    const isFresh =
      parsed.data.savedAtMs <= nowMs + 5 * 60 * 1_000 &&
      nowMs - parsed.data.savedAtMs <= SHORTS_PENDING_SOURCE_UPLOAD_MAX_AGE_MS;
    if (isFresh) unique.set(parsed.data.episodeId, parsed.data);
  }

  return JSON.stringify({
    version: 1,
    uploads: [...unique.values()].slice(-SHORTS_PENDING_SOURCE_UPLOADS_MAX),
  });
}

export function findMatchingPendingShortsSourceUpload(
  uploads: readonly PendingShortsSourceUpload[],
  file: Pick<File, "name" | "size" | "lastModified">,
): PendingShortsSourceUpload | null {
  return (
    [...uploads]
      .reverse()
      .find(
        (upload) =>
          upload.filename === file.name &&
          upload.fileSizeBytes === file.size &&
          upload.lastModifiedMs === file.lastModified,
      ) ?? null
  );
}

export function removePendingShortsSourceUpload(
  uploads: readonly PendingShortsSourceUpload[],
  episodeId: string,
): PendingShortsSourceUpload[] {
  return uploads.filter((upload) => upload.episodeId !== episodeId);
}
