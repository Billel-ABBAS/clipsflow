import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClientMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

type CookiePatch = {
  name: string;
  value: string;
  options: { path: string; httpOnly?: boolean; secure?: boolean; maxAge?: number };
};
type CookieAdapter = {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (cookies: CookiePatch[]) => void;
};

let batches: CookiePatch[][];
let cookiesAfterRefresh: Array<{ name: string; value: string }>;
const freshCookie: CookiePatch = {
  name: "sb-test-session",
  value: "fresh-test-session",
  options: { path: "/", httpOnly: true, secure: true },
};

async function runProxy(pathname = "/fr/dashboard") {
  const { default: proxy } = await import("@/proxy");
  return proxy(
    new NextRequest(new URL(pathname, "https://app.example.com"), {
      headers: {
        cookie: "sb-test-session=expired-test-session; theme=dark",
        "x-clipsflow-request-path": "/admin",
      },
    }),
  );
}

describe("proxy — renouvellement de session et routage next-intl", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-public-key");
    batches = [];
    cookiesAfterRefresh = [];
    createServerClientMock.mockReset();
    createServerClientMock.mockImplementation(
      (_url: string, _key: string, options: { cookies: CookieAdapter }) => ({
        auth: {
          getUser: async () => {
            for (const batch of batches) options.cookies.setAll(batch);
            cookiesAfterRefresh = options.cookies.getAll();
            return { data: { user: null }, error: null };
          },
        },
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("transmet immédiatement le cookie renouvelé au rendu serveur", async () => {
    batches = [[freshCookie]];
    const response = await runProxy();
    expect(response.headers.get("x-middleware-request-cookie")).toContain(
      "sb-test-session=fresh-test-session",
    );
    expect(response.headers.get("x-middleware-request-cookie")).not.toContain(
      "expired-test-session",
    );
    expect(response.headers.get("x-middleware-request-cookie")).toContain(
      "theme=dark",
    );
  });

  it("rend les cookies renouvelés visibles aux lectures suivantes de Supabase", async () => {
    batches = [[freshCookie]];
    await runProxy();
    expect(cookiesAfterRefresh).toContainEqual({
      name: freshCookie.name,
      value: freshCookie.value,
    });
  });

  it("conserve les options du cookie navigateur et interdit sa mise en cache", async () => {
    batches = [[freshCookie]];
    const response = await runProxy();
    expect(response.cookies.get(freshCookie.name)).toMatchObject({
      name: freshCookie.name,
      value: freshCookie.value,
      ...freshCookie.options,
    });
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("préserve la locale et remplace le chemin d'authentification fourni par le client", async () => {
    const response = await runProxy();
    expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe(
      "fr",
    );
    expect(
      response.headers.get("x-middleware-request-x-clipsflow-request-path"),
    ).toBe("/fr/dashboard");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get(freshCookie.name)).toBeUndefined();
  });

  it("conserve le dernier renouvellement quand Supabase émet plusieurs mises à jour", async () => {
    batches = [[freshCookie], [{ ...freshCookie, value: "latest-test-session" }]];
    const response = await runProxy();
    expect(response.headers.get("x-middleware-request-cookie")).toContain(
      "sb-test-session=latest-test-session",
    );
    expect(response.cookies.get(freshCookie.name)?.value).toBe(
      "latest-test-session",
    );
  });

  it("préserve une redirection de locale et ses nouveaux cookies", async () => {
    batches = [[freshCookie]];
    const response = await runProxy("/dashboard");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://app.example.com/en/dashboard",
    );
    expect(response.cookies.get(freshCookie.name)?.value).toBe(freshCookie.value);
  });

  it("répercute également la suppression d'un cookie de session", async () => {
    batches = [[{ ...freshCookie, value: "", options: { path: "/", maxAge: 0 } }]];
    const response = await runProxy();
    expect(response.headers.get("x-middleware-request-cookie")).not.toContain(
      "expired-test-session",
    );
    expect(response.cookies.get(freshCookie.name)?.maxAge).toBe(0);
  });

  it("garde le routage internationalisé sans variables Supabase", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const response = await runProxy();
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(response.headers.get("x-middleware-request-x-next-intl-locale")).toBe(
      "fr",
    );
  });
});
