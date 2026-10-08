import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortsStudio, type ShortsProject } from "./ShortsStudio";

const unavailableCapabilities = {
  audioAnalysis: false,
  videoAnalysis: false,
  creativeDirection: false,
  elevenLabs: false,
};

afterEach(() => vi.unstubAllEnvs());

describe("Studio visual truthfulness", () => {
  it("shows an honest import state without fake results or running analysis", () => {
    const html = renderToStaticMarkup(
      createElement(ShortsStudio, {
        locale: "fr",
        episodes: [],
        providerCapabilities: unavailableCapabilities,
      }),
    );
    expect(html).toContain("Prêt à analyser");
    expect(html).toContain("Votre prochain Short");
    expect(html).not.toContain("Analyse IA en cours");
    expect(html).not.toContain("moments trouvés");
    expect(html).not.toContain("shorts-reference");
    expect(html).toContain("Le service d’analyse Shorts n’est pas encore prêt");
  });

  it("keeps audio analysis available while clearly disabling video analysis", () => {
    const html = renderToStaticMarkup(
      createElement(ShortsStudio, {
        locale: "fr",
        episodes: [
          {
            id: "episode-ready",
            title: "Podcast de démonstration",
            sourceType: "upload",
            durationSeconds: 1_200,
            status: "ready",
            createdAt: "2026-10-08T10:00:00.000Z",
          },
        ],
        providerCapabilities: {
          audioAnalysis: true,
          videoAnalysis: false,
          creativeDirection: false,
          elevenLabs: false,
        },
      }),
    );

    expect(html).toContain(
      "L’analyse audio est prête, mais le fournisseur d’analyse vidéo n’est pas configuré",
    );
    const videoModeInput = html
      .match(/<input[^>]*>/gu)
      ?.find((input) => input.includes('value="audio_video"'));
    expect(videoModeInput).toContain('disabled=""');
  });

  it("never substitutes Canva media or invented cues in the real production studio", () => {
    vi.stubEnv("NODE_ENV", "production");
    const project: ShortsProject = {
      id: "actual-project",
      status: "ready",
      analysisQuotaExceeded: false,
      candidates: [
        {
          id: "actual-candidate",
          rank: 1,
          startSeconds: 754,
          endSeconds: 812,
          score: 94,
          title: "Titre de l’utilisateur",
          hook: "Une accroche issue du projet.",
          transcriptExcerpt:
            "Premier passage. Second passage. Troisième passage.",
          rationale: "Un extrait fourni par le serveur.",
          musicMood: "focused",
          motionDirection: "editorial-focus",
          visualSummary: null,
          selected: true,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(ShortsStudio, {
        locale: "fr",
        episodes: [],
        initialProject: project,
        viewerName: "Jean Dupont",
        providerCapabilities: unavailableCapabilities,
        designReference: {
          sourcePoster: "/images/shorts-reference/source.webp",
          candidatePosters: ["/images/shorts-reference/moment-1.webp"],
          previewPoster: "/images/shorts-reference/portrait.webp",
          waveform: "/images/shorts-reference/waveform.webp",
          transcriptLines: [
            { time: 757, text: "Une ligne inventée pour la maquette" },
          ],
        },
      }),
    );
    expect(html).toContain("Titre de l’utilisateur");
    expect(html).toContain("Premier passage.");
    expect(html).toContain("JD");
    expect(html).not.toContain("shorts-reference");
    expect(html).not.toContain("Une ligne inventée pour la maquette");
    expect(html).not.toContain("12:37");
    expect(html).not.toContain("Maquette");
    expect(html).not.toContain("data-preview-only");
  });

  it("keeps the explicitly read-only Canva demonstration identifiable in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = renderToStaticMarkup(
      createElement(ShortsStudio, {
        locale: "fr",
        episodes: [],
        previewOnly: true,
        providerCapabilities: unavailableCapabilities,
      }),
    );
    expect(html).toContain('data-preview-only="true"');
    expect(html).toContain("Démo · lecture seule");
    expect(html).toContain("aucun import, appel IA ou rendu n’est lancé");
    expect(html).toContain('href="/fr/shorts"');
    expect(html).not.toContain("Analyse IA en cours");
  });
});
