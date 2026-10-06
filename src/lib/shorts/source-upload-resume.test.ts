import { describe, expect, it } from "vitest";

import {
  findMatchingPendingShortsSourceUpload,
  parsePendingShortsSourceUploads,
  removePendingShortsSourceUpload,
  serialisePendingShortsSourceUploads,
  SHORTS_PENDING_SOURCE_UPLOAD_MAX_AGE_MS,
  SHORTS_PENDING_SOURCE_UPLOADS_MAX,
} from "./source-upload-resume";

const NOW = 1_800_000_000_000;
const episodeId = "123e4567-e89b-42d3-a456-426614174000";

function pendingUpload(overrides: Record<string, unknown> = {}) {
  return {
    episodeId,
    filename: "episode.mp4",
    fileSizeBytes: 120_000_000,
    lastModifiedMs: 1_700_000_000_000,
    title: "episode",
    savedAtMs: NOW - 1_000,
    ...overrides,
  };
}

describe("pending Shorts source upload metadata", () => {
  it("accepts only versioned, bounded, non-secret metadata", () => {
    const record = pendingUpload();
    const parsed = parsePendingShortsSourceUploads(
      { version: 1, uploads: [record] },
      NOW,
    );

    expect(parsed).toEqual([record]);
    expect(
      parsePendingShortsSourceUploads(
        { version: 1, uploads: [{ ...record, uploadToken: "secret" }] },
        NOW,
      ),
    ).toEqual([]);
    expect(
      parsePendingShortsSourceUploads({ version: 2, uploads: [record] }, NOW),
    ).toEqual([]);
  });

  it("drops stale or implausibly future-dated records", () => {
    expect(
      parsePendingShortsSourceUploads(
        {
          version: 1,
          uploads: [
            pendingUpload({
              savedAtMs: NOW - SHORTS_PENDING_SOURCE_UPLOAD_MAX_AGE_MS - 1,
            }),
            pendingUpload({
              episodeId: "123e4567-e89b-42d3-a456-426614174001",
              savedAtMs: NOW + 5 * 60 * 1_000 + 1,
            }),
          ],
        },
        NOW,
      ),
    ).toEqual([]);
  });

  it("bounds stored records, deduplicates by episode, and removes completed uploads", () => {
    const uploads = Array.from(
      { length: SHORTS_PENDING_SOURCE_UPLOADS_MAX + 2 },
      (_, index) =>
        pendingUpload({
          episodeId: `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
        }),
    );
    const serialised = serialisePendingShortsSourceUploads(
      [...uploads, uploads.at(-1)!],
      NOW,
    );
    const parsed = parsePendingShortsSourceUploads(
      JSON.parse(serialised) as unknown,
      NOW,
    );

    expect(parsed).toHaveLength(SHORTS_PENDING_SOURCE_UPLOADS_MAX);
    expect(
      removePendingShortsSourceUpload(parsed, parsed[0]!.episodeId),
    ).toHaveLength(SHORTS_PENDING_SOURCE_UPLOADS_MAX - 1);
  });

  it("matches a reselected file only when its stable browser metadata matches", () => {
    const record = pendingUpload();
    const uploads = [record];

    expect(
      findMatchingPendingShortsSourceUpload(uploads, {
        name: record.filename,
        size: record.fileSizeBytes,
        lastModified: record.lastModifiedMs,
      }),
    ).toEqual(record);
    expect(
      findMatchingPendingShortsSourceUpload(uploads, {
        name: record.filename,
        size: record.fileSizeBytes + 1,
        lastModified: record.lastModifiedMs,
      }),
    ).toBeNull();
  });
});
