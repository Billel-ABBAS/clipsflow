import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShortsStudio, type ShortsProject } from "./ShortsStudio";

const project: ShortsProject = {
  id: "actual-project",
  status: "ready",
  analysisQuotaExceeded: false,
  candidates: [{
    id: "actual-candidate", rank: 1, startSeconds: 10, endSeconds: 30,
    score: 90, title: "Un exemple", hook: "Une accroche autorisée.",
    transcriptExcerpt: "Un extrait déjà analysé.", rationale: "Une idée claire.",
    musicMood: "focused", motionDirection: "editorial-focus",
    visualSummary: null, selected: true,
  }],
};

describe("Railway audio rollout", () => {
  it("allows rendering a selected Short with original audio when optional generators are off", () => {
    const html = renderToStaticMarkup(createElement(ShortsStudio, {
      locale: "fr", episodes: [], initialProject: project,
      providerCapabilities: {
        audioAnalysis: true, videoAnalysis: false, creativeDirection: false,
        elevenLabs: false, voiceStudio: false,
      },
    }));
    const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu)
      ?.find((value) => value.includes("Générer le rendu"));
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
  });
});
