import { describe, expect, it } from "vitest";

import {
  SHORTS_SOURCE_MAX_BYTES,
  SHORTS_TUS_CHUNK_BYTES,
  buildShortsTusOptions,
  getShortsTusEndpoint,
  resolveShortsSourceMaxBytes,
  resolveShortsSourceMime,
  shortsSourceUploadCompleteSchema,
  shortsSourceUploadInitSchema,
} from "./source-upload";

describe("Shorts source upload contract", () => {
  it("allows supported video and podcast formats up to the product limit", () => {
    expect(
      shortsSourceUploadInitSchema.safeParse({
        file_name: "episode.mp4",
        mime: "video/mp4",
        size_bytes: SHORTS_SOURCE_MAX_BYTES,
        title: "Episode",
      }).success,
    ).toBe(true);
    expect(resolveShortsSourceMime("", "episode.MP4")).toBe("video/mp4");
    expect(
      resolveShortsSourceMime("application/octet-stream", "episode.m4a"),
    ).toBe("audio/mp4");
    expect(
      resolveShortsSourceMime("application/pdf", "episode.mp4"),
    ).toBeNull();
    expect(
      shortsSourceUploadInitSchema.safeParse({
        file_name: "episode.mp3",
        mime: "audio/mpeg",
        size_bytes: 1_024,
        title: "Episode",
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported MIME types, oversize uploads, and malformed completion sizes", () => {
    expect(
      shortsSourceUploadInitSchema.safeParse({
        file_name: "episode.ogg",
        mime: "audio/ogg",
        size_bytes: 1_024,
        title: "Episode",
      }).success,
    ).toBe(false);
    expect(
      shortsSourceUploadInitSchema.safeParse({
        file_name: "episode.mp4",
        mime: "video/mp4",
        size_bytes: SHORTS_SOURCE_MAX_BYTES + 1,
        title: "Episode",
      }).success,
    ).toBe(false);
    expect(
      shortsSourceUploadCompleteSchema.safeParse({ size_bytes: 0 }).success,
    ).toBe(false);
  });

  it("caps an optional worker disk limit without allowing it past the upload contract", () => {
    expect(resolveShortsSourceMaxBytes()).toBe(SHORTS_SOURCE_MAX_BYTES);
    expect(resolveShortsSourceMaxBytes(String(2 * 1024 ** 3))).toBe(
      2 * 1024 ** 3,
    );
    expect(resolveShortsSourceMaxBytes("invalid")).toBe(
      SHORTS_SOURCE_MAX_BYTES,
    );
    expect(
      resolveShortsSourceMaxBytes(String(SHORTS_SOURCE_MAX_BYTES + 1)),
    ).toBe(SHORTS_SOURCE_MAX_BYTES);
  });

  it("uses Supabase's direct storage hostname and rejects unsafe base URLs", () => {
    expect(getShortsTusEndpoint("https://project-ref.supabase.co")).toBe(
      "https://project-ref.storage.supabase.co/storage/v1/upload/resumable",
    );
    expect(getShortsTusEndpoint("http://127.0.0.1:54321")).toBe(
      "http://127.0.0.1:54321/storage/v1/upload/resumable",
    );
    expect(getShortsTusEndpoint("http://127.0.0.1:55321")).toBe(
      "http://127.0.0.1:55321/storage/v1/upload/resumable",
    );
    expect(getShortsTusEndpoint("https://storage.example.com")).toBe(
      "https://storage.example.com/storage/v1/upload/resumable",
    );
    expect(getShortsTusEndpoint("http://storage.example.com")).toBeNull();
    expect(getShortsTusEndpoint("https://example.com/base/path")).toBeNull();
    expect(getShortsTusEndpoint("https://user:pass@example.com")).toBeNull();
  });

  it("builds a signed, owner-authenticated TUS request with 6 MiB chunks", async () => {
    const options = buildShortsTusOptions({
      endpoint:
        "https://project-ref.storage.supabase.co/storage/v1/upload/resumable",
      bucket: "clip-sources",
      storagePath: "user-id/episode-id-episode.mp4",
      contentType: "video/mp4",
      uploadToken: "signed-path-token",
      accessToken: "user-access-token",
      apiKey: "public-anon-key",
      fingerprint: "upload-attempt-id",
    });

    expect(options.endpoint).toContain("storage.supabase.co");
    expect(options.chunkSize).toBe(SHORTS_TUS_CHUNK_BYTES);
    expect(options.headers).toEqual({
      authorization: "Bearer user-access-token",
      apikey: "public-anon-key",
      "x-signature": "signed-path-token",
    });
    expect(options.metadata).toMatchObject({
      bucketName: "clip-sources",
      objectName: "user-id/episode-id-episode.mp4",
      contentType: "video/mp4",
    });
    expect(await options.fingerprint()).toBe(
      "clipsflow-shorts:upload-attempt-id",
    );
  });
});
