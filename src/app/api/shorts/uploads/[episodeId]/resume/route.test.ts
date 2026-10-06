import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  episodeMaybeSingle: vi.fn(),
  episodeUpdateMaybeSingle: vi.fn(),
  signedUpload: vi.fn(),
  storageList: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "en" }) }),
}));

vi.mock("@/lib/clips/feature-flag", () => ({
  isClipsEnabled: async () => true,
}));

vi.mock("@/lib/rate-limit-distributed", () => ({
  checkDistributedRateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let isUpdate = false;
      const query: {
        select: () => typeof query;
        eq: () => typeof query;
        update: () => typeof query;
        maybeSingle: () => unknown;
      } = {
        select: () => query,
        eq: () => query,
        update: () => {
          isUpdate = true;
          return query;
        },
        maybeSingle: () =>
          isUpdate
            ? mocks.episodeUpdateMaybeSingle()
            : mocks.episodeMaybeSingle(),
      };
      return query;
    },
    storage: {
      from: () => ({
        list: mocks.storageList,
        createSignedUploadUrl: mocks.signedUpload,
      }),
    },
  }),
}));

import { POST } from "./route";

const episodeId = "123e4567-e89b-42d3-a456-426614174000";
const userId = "123e4567-e89b-42d3-a456-426614174001";

function request() {
  return new Request(
    `http://localhost/api/shorts/uploads/${episodeId}/resume`,
    {
      method: "POST",
    },
  );
}

function context(id = episodeId) {
  return { params: Promise.resolve({ episodeId: id }) };
}

describe("POST /api/shorts/uploads/[episodeId]/resume", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    mocks.getUser.mockReset().mockResolvedValue({
      data: { user: { id: userId } },
    });
    mocks.episodeMaybeSingle.mockReset().mockResolvedValue({
      data: {
        id: episodeId,
        user_id: userId,
        source_type: "upload",
        source_storage_path: `${userId}/source.mp4`,
        status: "pending",
      },
      error: null,
    });
    mocks.signedUpload.mockReset().mockResolvedValue({
      data: { token: "signed-upload-token" },
      error: null,
    });
    mocks.storageList.mockReset().mockResolvedValue({ data: [], error: null });
    mocks.episodeUpdateMaybeSingle
      .mockReset()
      .mockResolvedValue({ data: { id: episodeId }, error: null });
    mocks.rateLimit.mockReset().mockResolvedValue({ allowed: true });
  });

  it("reissues a short-lived token only for the authenticated owner’s pending upload", async () => {
    const response = await POST(request(), context());
    const payload = (await response.json()) as {
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload.data).toMatchObject({
      episode_id: episodeId,
      status: "pending",
      upload_token: "signed-upload-token",
      storage_path: `${userId}/source.mp4`,
      endpoint: "http://127.0.0.1:54321/storage/v1/upload/resumable",
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.anything(),
      `shorts-source-upload-resume:${userId}`,
      20,
      600,
    );
  });

  it("returns ready without issuing a new token for an already completed upload", async () => {
    mocks.episodeMaybeSingle.mockResolvedValueOnce({
      data: {
        id: episodeId,
        user_id: userId,
        source_type: "upload",
        source_storage_path: `${userId}/source.mp4`,
        status: "ready",
      },
      error: null,
    });

    const response = await POST(request(), context());
    const payload = (await response.json()) as {
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(payload.data).toEqual({ episode_id: episodeId, status: "ready" });
    expect(mocks.signedUpload).not.toHaveBeenCalled();
  });

  it("finalizes an upload object left behind before the completion callback", async () => {
    mocks.storageList.mockResolvedValueOnce({
      data: [{ name: "source.mp4", metadata: { size: "900" } }],
      error: null,
    });

    const response = await POST(request(), context());
    const payload = (await response.json()) as {
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(payload.data).toEqual({ episode_id: episodeId, status: "ready" });
    expect(mocks.episodeUpdateMaybeSingle).toHaveBeenCalledOnce();
    expect(mocks.signedUpload).not.toHaveBeenCalled();
  });

  it("does not disclose missing, non-owner, or non-pending source records", async () => {
    mocks.episodeMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const missing = await POST(request(), context());
    expect(missing.status).toBe(404);

    mocks.episodeMaybeSingle.mockResolvedValueOnce({
      data: {
        id: episodeId,
        user_id: userId,
        source_type: "upload",
        source_storage_path: `${userId}/source.mp4`,
        status: "analyzing",
      },
      error: null,
    });
    const notPending = await POST(request(), context());
    expect(notPending.status).toBe(409);
  });

  it("rejects unauthenticated and malformed episode identifiers", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null } });
    const unauthenticated = await POST(request(), context());
    expect(unauthenticated.status).toBe(401);

    const malformed = await POST(request(), context("not-a-uuid"));
    expect(malformed.status).toBe(404);
  });
});
