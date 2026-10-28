import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolveCapabilities: vi.fn(),
  createAdmin: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "fr" }) }),
}));
vi.mock("@/lib/clips/feature-flag", () => ({ isClipsEnabled: () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdmin,
}));
vi.mock("@/lib/shorts/provider-capabilities-server", () => ({
  resolveShortsProviderCapabilitiesForServer: mocks.resolveCapabilities,
}));

import { POST } from "./route";

const allowed = "123e4567-e89b-42d3-a456-426614174000";
const other = "123e4567-e89b-42d3-a456-426614174001";
const request = () =>
  new Request("http://localhost/api/shorts/projects", { method: "POST" });

describe("analysis admission API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: other } } });
    mocks.resolveCapabilities.mockResolvedValue({ audioAnalysis: false });
    vi.stubEnv("SHORTS_ANALYSIS_ALLOWED_USER_ID", allowed);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects another account before a health query, admin access or queue write", async () => {
    expect((await POST(request())).status).toBe(503);
    expect(mocks.resolveCapabilities).not.toHaveBeenCalled();
    expect(mocks.createAdmin).not.toHaveBeenCalled();
  });

  it("still requires the regular readiness gate for the permitted account", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: allowed } } });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.resolveCapabilities).toHaveBeenCalledOnce();
    expect(mocks.createAdmin).not.toHaveBeenCalled();
  });

  it("refuses malformed deployment configuration before privileged access", async () => {
    vi.stubEnv("SHORTS_ANALYSIS_ALLOWED_USER_ID", "invalid");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.resolveCapabilities).not.toHaveBeenCalled();
    expect(mocks.createAdmin).not.toHaveBeenCalled();
  });
});
