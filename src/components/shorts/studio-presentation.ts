import type { ShortsCandidate, ShortsProject } from "./ShortsStudio";

export type CandidateFilter =
  | "all"
  | "selected"
  | "high_score"
  | "questions"
  | "playful";
export type CandidateSort = "rank" | "score" | "chronological" | "duration";

export function searchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

/** Local review filters use actual fields, never invented AI categories. */
export function filterShortsCandidates(
  candidates: readonly ShortsCandidate[],
  selected: ReadonlySet<string>,
  filter: CandidateFilter,
  query = "",
  sort: CandidateSort = "rank",
): ShortsCandidate[] {
  const needle = searchText(query);
  return candidates
    .filter((candidate) => {
      const content = `${candidate.title} ${candidate.hook} ${candidate.transcriptExcerpt}`;
      if (needle && !searchText(content).includes(needle)) return false;
      if (filter === "selected") return selected.has(candidate.id);
      if (filter === "high_score") return candidate.score >= 85;
      if (filter === "questions")
        return /\?|\b(comment|pourquoi|how|why|what)\b/iu.test(content);
      if (filter === "playful") return candidate.musicMood === "playful";
      return true;
    })
    .sort((a, b) => {
      if (sort === "score") return b.score - a.score || a.rank - b.rank;
      if (sort === "chronological")
        return a.startSeconds - b.startSeconds || a.rank - b.rank;
      if (sort === "duration")
        return (
          a.endSeconds - a.startSeconds - (b.endSeconds - b.startSeconds) ||
          a.rank - b.rank
        );
      return a.rank - b.rank;
    });
}

export function resolveStudioPhase(
  project: ShortsProject | null,
  creating = false,
) {
  if (creating) return "processing" as const;
  if (!project || project.status === "draft") return "source" as const;
  if (project.status === "failed") return "failed" as const;
  if (project.status === "ready") return "ready" as const;
  return "processing" as const;
}

export function formatSourceDuration(seconds: number, french: boolean): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours} h ${minutes % 60} min`
    : `${minutes} ${french ? "min" : "min"}`;
}
