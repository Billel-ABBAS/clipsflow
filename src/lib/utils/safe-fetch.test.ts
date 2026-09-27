import { describe, expect, it, vi } from "vitest";
import { OutboundUrlError } from "@/lib/security/validate-outbound-url";
import { safeFetch } from "./safe-fetch";

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 as const },
];

describe("safeFetch — SSRF et redirections", () => {
  it("ne lance aucun fetch quand le DNS initial est privé", async () => {
    const fetchImpl = vi.fn();

    await expect(
      safeFetch("https://cdn.example.com/file", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OutboundUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bloque une redirection vers une adresse interne avant le second fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
    );

    await expect(
      safeFetch("https://cdn.example.com/file", {
        lookup: publicLookup,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OutboundUrlError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("valide le DNS et l'allowlist à chaque redirection publique", async () => {
    const lookup = vi.fn(publicLookup);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "/next" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await safeFetch("https://cdn.example.com/file", {
      allowedHosts: ["cdn.example.com"],
      lookup,
      fetchImpl,
    });

    expect(await response.text()).toBe("ok");
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuse une redirection publique hors allowlist", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/file" },
      }),
    );

    await expect(
      safeFetch("https://cdn.example.com/file", {
        allowedHosts: ["cdn.example.com"],
        lookup: publicLookup,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OutboundUrlError);
  });

  it("borne le nombre de redirections", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "/again" },
      }),
    );

    await expect(
      safeFetch("https://cdn.example.com/file", {
        maxRedirects: 2,
        lookup: publicLookup,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OutboundUrlError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
