import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({ setRequestLocale: vi.fn() }));

import ShortsPreviewPage, { metadata } from "./page";

afterEach(() => vi.unstubAllEnvs());

describe("Public read-only Canva studio demonstration", () => {
  it("serves the approved selection view in production without enabling real jobs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const page = await ShortsPreviewPage({
      params: Promise.resolve({ locale: "fr" }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('data-preview-only="true"');
    expect(html).toContain("Démo · lecture seule");
    expect(html).toContain("Une promesse qui se vit");
    expect(html).toContain("moments trouvés");
    expect(html).toContain("/images/shorts-reference/portrait.webp");
    expect(html).toContain("Forme d’onde de la maquette Canva");
    expect(html).toContain("Maquette");
    expect(html).not.toContain("/api/auth/youtube");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("offers an honest empty state without demo results or media", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const page = await ShortsPreviewPage({
      params: Promise.resolve({ locale: "fr" }),
      searchParams: Promise.resolve({ state: "empty" }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("Prêt à analyser");
    expect(html).toContain("Démo · lecture seule");
    expect(html).not.toContain("moments trouvés");
    expect(html).not.toContain("shorts-reference");
  });

  it("retains the read-only notice and signed-in studio link for English", async () => {
    const page = await ShortsPreviewPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("Demo · read only");
    expect(html).toContain("no upload, AI call or render is started");
    expect(html).toContain('href="/en/shorts"');
  });
});
