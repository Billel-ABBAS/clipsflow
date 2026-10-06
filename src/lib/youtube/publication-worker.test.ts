import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  refreshAccessToken: vi.fn(),
  checkUploadSession: vi.fn(),
  createUploadSession: vi.fn(),
  uploadChunk: vi.fn(),
}));

vi.mock("@/lib/utils/safe-fetch", () => ({ safeFetch: mocks.safeFetch }));
vi.mock("./google-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./google-api")>();
  return {
    ...actual,
    refreshYouTubeAccessToken: mocks.refreshAccessToken,
    checkYouTubeUploadSession: mocks.checkUploadSession,
    createYouTubeUploadSession: mocks.createUploadSession,
    uploadYouTubeChunk: mocks.uploadChunk,
  };
});

import {
  encryptYouTubeRefreshToken,
  encryptYouTubeUploadSessionUri,
  decryptYouTubeUploadSessionUri,
} from "./token-vault";
import { processOneYouTubePublicationJob } from "./publication-worker";
import { YouTubeProviderError } from "./google-api";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "20000000-0000-4000-8000-000000000002";
const CLIP_ID = "30000000-0000-4000-8000-000000000003";
const PUBLICATION_ID = "40000000-0000-4000-8000-000000000004";
const LEASE_TOKEN = "50000000-0000-4000-8000-000000000005";
const VIDEO_ID = "abcdefghijk";
const SESSION_URI =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=test-session";
const VIDEO_BYTES = Buffer.from("short-video-fixture");
const VAULT_KEY = Buffer.alloc(32, 7);

function fakeQuery(result: { data: unknown; error: null }) {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => result);
  query.update = vi.fn(() => query);
  return query;
}

function makeAdmin(
  order: string[],
  uploadSessionUriCiphertext: string | null = null,
  visibility: "private" | "unlisted" | "public" = "private",
  signedUrl = `https://project-ref.supabase.co/storage/v1/object/sign/clip-outputs/${USER_ID}/${CLIP_ID}/final.mp4`,
) {
  const encryptedRefreshToken = encryptYouTubeRefreshToken({
    refreshToken: "fixture-refresh-token",
    context: { userId: USER_ID, connectionId: CONNECTION_ID },
    key: VAULT_KEY,
  });
  const publicationQuery = fakeQuery({
    data: {
      id: PUBLICATION_ID,
      user_id: USER_ID,
      clip_id: CLIP_ID,
      youtube_connection_id: CONNECTION_ID,
      title: "A tested short",
      description: "",
      tags: [],
      visibility,
      made_for_kids: false,
      contains_synthetic_media: false,
      notify_subscribers: false,
      attempt_count: 1,
      upload_session_uri_ciphertext: uploadSessionUriCiphertext,
    },
    error: null,
  });
  const connectionQuery = fakeQuery({
    data: {
      id: CONNECTION_ID,
      user_id: USER_ID,
      refresh_token_ciphertext: encryptedRefreshToken,
      is_active: true,
    },
    error: null,
  });
  const clipQuery = fakeQuery({
    data: {
      id: CLIP_ID,
      user_id: USER_ID,
      status: "completed",
      video_storage_path: `${USER_ID}/${CLIP_ID}/final.mp4`,
    },
    error: null,
  });
  const from = vi.fn((table: string) => {
    if (table === "shorts_publications") return publicationQuery;
    if (table === "youtube_connections") return connectionQuery;
    if (table === "clips") return clipQuery;
    throw new Error(`unexpected_table:${table}`);
  });
  const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    rpcCalls.push({ name, ...(args ? { args } : {}) });
    order.push(name);
    switch (name) {
      case "shorts_claim_youtube_publication":
        return {
          data: [{ publication_id: PUBLICATION_ID, lease_token: LEASE_TOKEN }],
          error: null,
        };
      case "shorts_renew_youtube_publication_lease":
      case "shorts_save_youtube_upload_progress":
      case "shorts_complete_youtube_publication":
      case "shorts_fail_youtube_publication":
        return { data: true, error: null };
      default:
        return { data: null, error: { message: `unexpected_rpc:${name}` } };
    }
  });
  const storageFrom = vi.fn(() => ({
    list: vi.fn(async () => ({
      data: [{ name: "final.mp4", metadata: { size: VIDEO_BYTES.byteLength } }],
      error: null,
    })),
    createSignedUrl: vi.fn(async () => ({
      data: { signedUrl },
      error: null,
    })),
  }));
  return {
    admin: {
      rpc,
      from,
      storage: { from: storageFrom },
    } as unknown as SupabaseClient,
    rpc,
    rpcCalls,
    from,
  };
}

function configureWorkerEnvironment(enabled = "true"): void {
  vi.stubEnv("YOUTUBE_PUBLISH_WORKER_ENABLED", enabled);
  vi.stubEnv("YOUTUBE_OAUTH_CLIENT_ID", "fixture-client-id");
  vi.stubEnv("YOUTUBE_OAUTH_CLIENT_SECRET", "fixture-client-secret");
  vi.stubEnv(
    "YOUTUBE_OAUTH_REDIRECT_URI",
    "https://clips.example.com/api/youtube/oauth/callback",
  );
  vi.stubEnv("YOUTUBE_OAUTH_STATE_SECRET", "fixture-state-secret-long-enough");
  vi.stubEnv("YOUTUBE_TOKEN_ENCRYPTION_KEY", VAULT_KEY.toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
}

describe("YouTube publication worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.refreshAccessToken.mockResolvedValue({
      accessToken: "fixture-access-token",
      expiresIn: 3_600,
    });
    mocks.checkUploadSession.mockResolvedValue({
      kind: "incomplete",
      nextOffset: 0,
    });
    mocks.createUploadSession.mockResolvedValue(SESSION_URI);
    mocks.uploadChunk.mockImplementation(async () => {
      return { kind: "complete", videoId: VIDEO_ID };
    });
    mocks.safeFetch.mockResolvedValue(
      new Response(VIDEO_BYTES, {
        headers: { "content-length": String(VIDEO_BYTES.byteLength) },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not claim a publication while its worker switch is off", async () => {
    vi.stubEnv("YOUTUBE_PUBLISH_WORKER_ENABLED", "false");
    const rpc = vi.fn();

    await expect(
      processOneYouTubePublicationJob({ rpc } as unknown as SupabaseClient),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts the numeric worker switch used by the one-shot entrypoint", async () => {
    configureWorkerEnvironment("1");
    const order: string[] = [];
    const { admin, rpc } = makeAdmin(order);

    await expect(processOneYouTubePublicationJob(admin)).resolves.toMatchObject(
      {
        kind: "published",
        publicationId: PUBLICATION_ID,
        videoId: VIDEO_ID,
      },
    );
    expect(rpc).toHaveBeenCalledWith(
      "shorts_claim_youtube_publication",
      expect.any(Object),
    );
  });

  it("stops queued non-private uploads when their worker kill switch is off", async () => {
    configureWorkerEnvironment();
    vi.stubEnv("YOUTUBE_PUBLIC_UPLOADS_ENABLED", "false");
    const order: string[] = [];
    const { admin, rpc } = makeAdmin(order, null, "public");

    await expect(processOneYouTubePublicationJob(admin)).resolves.toEqual({
      kind: "failed",
      publicationId: PUBLICATION_ID,
      errorCode: "youtube_public_uploads_disabled",
    });

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.createUploadSession).not.toHaveBeenCalled();
    expect(mocks.uploadChunk).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "shorts_fail_youtube_publication",
      expect.objectContaining({
        p_publication_id: PUBLICATION_ID,
        p_lease_token: LEASE_TOKEN,
        p_error_code: "youtube_public_uploads_disabled",
        p_retryable: false,
      }),
    );
  });

  it("uploads a confirmed private Short and persists only an encrypted resumable URL", async () => {
    configureWorkerEnvironment();
    const order: string[] = [];
    const { admin, rpc, rpcCalls, from } = makeAdmin(order);
    mocks.createUploadSession.mockImplementation(async () => {
      order.push("create-session");
      return SESSION_URI;
    });
    mocks.uploadChunk.mockImplementation(async () => {
      order.push("upload-chunk");
      return { kind: "complete", videoId: VIDEO_ID };
    });

    await expect(processOneYouTubePublicationJob(admin)).resolves.toEqual({
      kind: "published",
      publicationId: PUBLICATION_ID,
      videoId: VIDEO_ID,
    });

    const saveProgressCall = rpcCalls.find(
      ({ name }) => name === "shorts_save_youtube_upload_progress",
    );
    expect(saveProgressCall?.args).toEqual({
      p_publication_id: PUBLICATION_ID,
      p_lease_token: LEASE_TOKEN,
      p_session_uri_ciphertext: expect.any(String),
      p_upload_offset_bytes: 0,
    });
    const encryptedSessionUri =
      saveProgressCall?.args?.p_session_uri_ciphertext;
    expect(encryptedSessionUri).not.toBe(SESSION_URI);
    expect(
      decryptYouTubeUploadSessionUri({
        ciphertext: String(encryptedSessionUri),
        context: { userId: USER_ID, connectionId: CONNECTION_ID },
        key: VAULT_KEY,
      }),
    ).toBe(SESSION_URI);
    expect(order.indexOf("shorts_save_youtube_upload_progress")).toBeLessThan(
      order.indexOf("upload-chunk"),
    );
    expect(order.indexOf("upload-chunk")).toBeLessThan(
      order.indexOf("shorts_complete_youtube_publication"),
    );
    expect(mocks.uploadChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "fixture-access-token",
        sessionUri: SESSION_URI,
        contentLength: VIDEO_BYTES.byteLength,
        startOffset: 0,
        bytes: VIDEO_BYTES,
      }),
    );
    expect(mocks.refreshAccessToken).toHaveBeenCalledWith({
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret",
      refreshToken: "fixture-refresh-token",
    });
    expect(from).toHaveBeenCalledWith("shorts_publications");
    expect(from).toHaveBeenCalledWith("youtube_connections");
    expect(from).toHaveBeenCalledWith("clips");
    expect(rpc).toHaveBeenCalledWith("shorts_complete_youtube_publication", {
      p_publication_id: PUBLICATION_ID,
      p_lease_token: LEASE_TOKEN,
      p_youtube_video_id: VIDEO_ID,
    });
  });

  it("allows only the exact local Supabase origin when downloading in development", async () => {
    configureWorkerEnvironment();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    const order: string[] = [];
    const signedUrl = `http://127.0.0.1:54321/storage/v1/object/sign/clip-outputs/${USER_ID}/${CLIP_ID}/final.mp4?token=fixture`;
    const { admin } = makeAdmin(order, null, "private", signedUrl);

    await expect(processOneYouTubePublicationJob(admin)).resolves.toEqual({
      kind: "published",
      publicationId: PUBLICATION_ID,
      videoId: VIDEO_ID,
    });

    expect(mocks.safeFetch).toHaveBeenCalledWith(
      signedUrl,
      expect.objectContaining({
        allowHttpOrigin: "http://127.0.0.1:54321",
        allowedHosts: undefined,
      }),
    );
  });

  it("resumes an interrupted upload from YouTube's acknowledged byte offset", async () => {
    configureWorkerEnvironment();
    const order: string[] = [];
    const sessionCiphertext = encryptYouTubeUploadSessionUri({
      uploadSessionUri: SESSION_URI,
      context: { userId: USER_ID, connectionId: CONNECTION_ID },
      key: VAULT_KEY,
    });
    const { admin, rpcCalls } = makeAdmin(order, sessionCiphertext);
    mocks.checkUploadSession.mockResolvedValue({
      kind: "incomplete",
      nextOffset: 5,
    });
    mocks.uploadChunk.mockImplementation(async () => {
      order.push("upload-resumed-chunk");
      return { kind: "complete", videoId: VIDEO_ID };
    });

    await expect(processOneYouTubePublicationJob(admin)).resolves.toEqual({
      kind: "published",
      publicationId: PUBLICATION_ID,
      videoId: VIDEO_ID,
    });

    expect(mocks.checkUploadSession).toHaveBeenCalledWith({
      accessToken: "fixture-access-token",
      sessionUri: SESSION_URI,
      contentLength: VIDEO_BYTES.byteLength,
    });
    expect(mocks.createUploadSession).not.toHaveBeenCalled();
    expect(mocks.uploadChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUri: SESSION_URI,
        startOffset: 5,
        bytes: VIDEO_BYTES.subarray(5),
      }),
    );
    expect(
      rpcCalls.some(
        ({ name }) => name === "shorts_save_youtube_upload_progress",
      ),
    ).toBe(false);
  });

  it("finalizes an upload already completed by YouTube without sending bytes again", async () => {
    configureWorkerEnvironment();
    const order: string[] = [];
    const sessionCiphertext = encryptYouTubeUploadSessionUri({
      uploadSessionUri: SESSION_URI,
      context: { userId: USER_ID, connectionId: CONNECTION_ID },
      key: VAULT_KEY,
    });
    const { admin, rpc } = makeAdmin(order, sessionCiphertext);
    mocks.checkUploadSession.mockResolvedValue({
      kind: "complete",
      videoId: VIDEO_ID,
    });

    await expect(processOneYouTubePublicationJob(admin)).resolves.toEqual({
      kind: "published",
      publicationId: PUBLICATION_ID,
      videoId: VIDEO_ID,
    });

    expect(mocks.createUploadSession).not.toHaveBeenCalled();
    expect(mocks.uploadChunk).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("shorts_complete_youtube_publication", {
      p_publication_id: PUBLICATION_ID,
      p_lease_token: LEASE_TOKEN,
      p_youtube_video_id: VIDEO_ID,
    });
  });

  it("queues a bounded retry for a retryable Google refresh failure", async () => {
    configureWorkerEnvironment();
    const order: string[] = [];
    const { admin, rpc } = makeAdmin(order);
    mocks.refreshAccessToken.mockRejectedValue(
      new YouTubeProviderError("oauth_refresh_failed", true),
    );

    await expect(processOneYouTubePublicationJob(admin)).resolves.toEqual({
      kind: "queued_retry",
      publicationId: PUBLICATION_ID,
      errorCode: "oauth_refresh_failed",
    });
    expect(rpc).toHaveBeenCalledWith(
      "shorts_fail_youtube_publication",
      expect.objectContaining({
        p_publication_id: PUBLICATION_ID,
        p_lease_token: LEASE_TOKEN,
        p_error_code: "oauth_refresh_failed",
        p_retryable: true,
        p_retry_delay_seconds: 30,
      }),
    );
    expect(mocks.createUploadSession).not.toHaveBeenCalled();
    expect(mocks.uploadChunk).not.toHaveBeenCalled();
  });
});
