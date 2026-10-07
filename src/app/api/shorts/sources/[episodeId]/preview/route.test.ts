import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  isClipsEnabled: vi.fn(),
  episodeMaybeSingle: vi.fn(),
  rateLimit: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "fr" }) }),
}));

vi.mock("@/lib/clips/feature-flag", () => ({
  isClipsEnabled: mocks.isClipsEnabled,
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
      const query: {
        select: () => typeof query;
        eq: () => typeof query;
        maybeSingle: () => unknown;
      } = {
        select: () => query,
        eq: () => query,
        maybeSingle: () => mocks.episodeMaybeSingle(),
      };
      return query;
    },
    storage: {
      from: () => ({ createSignedUrl: mocks.createSignedUrl }),
    },
  }),
}));

import { GET } from "./route";

const episodeId = "123e4567-e89b-42d3-a456-426614174000";
const userId = "123e4567-e89b-42d3-a456-426614174001";

function request() {
  return new Request(
    `http://localhost/api/shorts/sources/${episodeId}/preview`,
  );
}

function context(id = episodeId) {
  return { params: Promise.resolve({ episodeId: id }) };
}

describe("GET /api/shorts/sources/[episodeId]/preview", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    mocks.getUser.mockReset().mockResolvedValue({
      data: { user: { id: userId } },
    });
    mocks.isClipsEnabled.mockReset().mockResolvedValue(true);
    mocks.episodeMaybeSingle.mockReset().mockResolvedValue({
      data: {
        id: episodeId,
        user_id: userId,
        source_type: "upload",
        source_storage_path: `${userId}/source.mp4`,
        status: "ready",
      },
      error: null,
    });
    mocks.rateLimit.mockReset().mockResolvedValue({ allowed: true });
    mocks.createSignedUrl.mockReset().mockResolvedValue({
      data: { signedUrl: "https://storage.example.test/signed-source" },
      error: null,
    });
  });

  it("signs a short-lived URL for a ready source owned by the viewer", async () => {
    const response = await GET(request(), context());
    const payload = (await response.json()) as {
      data: { url: string };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload.data.url).toBe("https://storage.example.test/signed-source");
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(
      `${userId}/source.mp4`,
      3600,
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.anything(),
      `shorts-source-preview:${userId}`,
      60,
      60,
    );
  });

  it("does not sign missing, foreign, non-upload, pending, or unsafe sources", async () => {
    mocks.episodeMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await GET(request(), context())).status).toBe(404);

    mocks.episodeMaybeSingle.mockResolvedValueOnce({
      data: {
        id: episodeId,
        user_id: "123e4567-e89b-42d3-a456-426614174002",
        source_type: "upload",
        source_storage_path: `${userId}/source.mp4`,
        status: "ready",
      },
      error: null,
    });
    expect((await GET(request(), context())).status).toBe(404);

    mocks.episodeMaybeSingle.mockResolvedValueOnce({
      data: {
        id: episodeId,
        user_id: userId,
        source_type: "url",
        source_storage_path: `${userId}/source.mp4`,
        status: "ready",
      },
      error: null,
    });
    expect((await GET(request(), context())).status).toBe(404);

    mocks.episodeMaybeSingle.mockResolvedValueOnce({
      data: {
        id: episodeId,
        user_id: userId,
        source_type: "upload",
        source_storage_path: `${userId}/source.mp4`,
        status: "pending",
      },
      error: null,
    });
    expect((await GET(request(), context())).status).toBe(404);

    mocks.episodeMaybeSingle.mockResolvedValueOnce({
      data: {
        id: episodeId,
        user_id: userId,
        source_type: "upload",
        source_storage_path: "other-user/source.mp4",
        status: "ready",
      },
      error: null,
    });
    expect((await GET(request(), context())).status).toBe(404);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it("requires the signed-in user and the Shorts feature", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await GET(request(), context())).status).toBe(401);

    mocks.isClipsEnabled.mockResolvedValueOnce(false);
    expect((await GET(request(), context())).status).toBe(403);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs and returns a private error if signing fails", async () => {
    expect((await GET(request(), context("not-a-uuid"))).status).toBe(404);

    mocks.createSignedUrl.mockResolvedValueOnce({ data: null, error: {} });
    const failed = await GET(request(), context());
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
  });

  it("honors the per-user rate limit", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 12,
    });
    const response = await GET(request(), context());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(mocks.episodeMaybeSingle).not.toHaveBeenCalled();
  });
});
