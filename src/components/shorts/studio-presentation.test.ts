import { describe, expect, it } from "vitest";
import {
  filterShortsCandidates,
  formatSourceDuration,
  resolveStudioPhase,
  searchText,
} from "./studio-presentation";
import type { ShortsCandidate, ShortsProject } from "./ShortsStudio";

const candidates: ShortsCandidate[] = [
  {
    id: "a",
    rank: 1,
    score: 94,
    startSeconds: 90,
    endSeconds: 148,
    title: "Une promesse",
    hook: "Créer la confiance",
    transcriptExcerpt: "Cohérence à chaque étape.",
    musicMood: "focused",
    rationale: "",
    motionDirection: "",
    visualSummary: null,
    selected: false,
  },
  {
    id: "b",
    rank: 2,
    score: 87,
    startSeconds: 10,
    endSeconds: 56,
    title: "Pourquoi disparaissent-elles ?",
    hook: "Une question",
    transcriptExcerpt: "Le lien avec votre audience.",
    musicMood: "warm",
    rationale: "",
    motionDirection: "",
    visualSummary: null,
    selected: true,
  },
  {
    id: "c",
    rank: 3,
    score: 83,
    startSeconds: 40,
    endSeconds: 89,
    title: "Le rire",
    hook: "Un moment léger",
    transcriptExcerpt: "Faire sourire.",
    musicMood: "playful",
    rationale: "",
    motionDirection: "",
    visualSummary: null,
    selected: false,
  },
];

describe("Studio review presentation", () => {
  it("uses actual selection and score data for filters", () => {
    expect(
      filterShortsCandidates(candidates, new Set(["a"]), "selected").map(
        (c) => c.id,
      ),
    ).toEqual(["a"]);
    expect(
      filterShortsCandidates(candidates, new Set(), "high_score").map(
        (c) => c.id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      filterShortsCandidates(candidates, new Set(), "questions").map(
        (c) => c.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterShortsCandidates(candidates, new Set(), "playful").map((c) => c.id),
    ).toEqual(["c"]);
  });
  it("searches accents across title, hook and the full excerpt", () => {
    expect(searchText("ÉTAPE")).toBe("etape");
    expect(
      filterShortsCandidates(candidates, new Set(), "all", "coherence").map(
        (c) => c.id,
      ),
    ).toEqual(["a"]);
    expect(
      filterShortsCandidates(candidates, new Set(), "all", "absent"),
    ).toEqual([]);
  });
  it("preserves server rank by default and does not mutate candidates", () => {
    expect(
      filterShortsCandidates(candidates, new Set(), "all").map((c) => c.id),
    ).toEqual(["a", "b", "c"]);
    expect(
      filterShortsCandidates(
        candidates,
        new Set(),
        "all",
        "",
        "chronological",
      ).map((c) => c.id),
    ).toEqual(["b", "c", "a"]);
    expect(
      filterShortsCandidates(candidates, new Set(), "all", "", "duration").map(
        (c) => c.id,
      ),
    ).toEqual(["b", "c", "a"]);
    expect(candidates.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
  it("never describes an idle, draft or failed analysis as running", () => {
    const project = (status: ShortsProject["status"]): ShortsProject => ({
      id: "p",
      status,
      candidates: [],
      analysisQuotaExceeded: false,
    });
    expect(resolveStudioPhase(null)).toBe("source");
    expect(resolveStudioPhase(project("draft"))).toBe("source");
    expect(resolveStudioPhase(project("failed"))).toBe("failed");
    expect(resolveStudioPhase(project("queued"))).toBe("processing");
    expect(resolveStudioPhase(project("transcribing"))).toBe("processing");
    expect(resolveStudioPhase(project("analyzing"))).toBe("processing");
    expect(resolveStudioPhase(project("ready"))).toBe("ready");
    expect(resolveStudioPhase(null, true)).toBe("processing");
  });
  it("formats the source duration for a human rather than a player", () => {
    expect(formatSourceDuration(4680, true)).toBe("1 h 18 min");
    expect(formatSourceDuration(1200, false)).toBe("20 min");
    expect(formatSourceDuration(NaN, true)).toBe("—");
  });
});
