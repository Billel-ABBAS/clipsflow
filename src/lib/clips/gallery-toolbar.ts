// ============================================================================
// ClipsFlow Clips — gallery toolbar pure helpers
// ============================================================================
// Extracted filter/sort logic for the clip gallery so it is unit-testable
// without pulling next-intl into the Playwright unit runner.
//
// Ported from VidiaFlow src/lib/clipflow/gallery-toolbar.ts.
// Adaptation : import of ClipStatus from `./types` instead of `./subtitle-types`.
// ============================================================================

import type { ClipStatus } from "./types";

export type StatusFilter = "all" | "completed" | "processing" | "failed";
export type AspectFilter = "all" | "9:16" | "1:1" | "4:5" | "16:9";
export type SortKey = "recent" | "oldest" | "hook_desc";

export interface GalleryToolbarValue {
  status: StatusFilter;
  aspect: AspectFilter;
  sort: SortKey;
  search: string;
}

export const DEFAULT_TOOLBAR: GalleryToolbarValue = {
  status: "all",
  aspect: "all",
  sort: "recent",
  search: "",
};

export interface ToolbarRow {
  status: ClipStatus;
  aspect_ratio: string | null;
  style_key: string | null;
  created_at: string;
  score: number | null;
}

/** Pure filter+sort fn. Returns a fresh array — does not mutate input. */
export function applyToolbar<T extends ToolbarRow>(
  jobs: T[],
  v: GalleryToolbarValue,
): T[] {
  let next = jobs.slice();

  if (v.status !== "all") {
    if (v.status === "processing") {
      next = next.filter(
        (j) =>
          j.status === "pending" ||
          j.status === "processing" ||
          j.status === "completing",
      );
    } else if (v.status === "completed") {
      next = next.filter((j) => j.status === "completed");
    } else if (v.status === "failed") {
      next = next.filter((j) => j.status === "failed");
    }
  }

  if (v.aspect !== "all") {
    next = next.filter((j) => j.aspect_ratio === v.aspect);
  }

  if (v.search.trim()) {
    const q = v.search.trim().toLowerCase();
    next = next.filter((j) => {
      const haystack =
        `${j.style_key ?? ""} ${j.aspect_ratio ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  if (v.sort === "recent") {
    next.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  } else if (v.sort === "oldest") {
    next.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  } else if (v.sort === "hook_desc") {
    // Source used `hook_score` field name; ClipsFlow `clips` table uses `score`.
    next.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }

  return next;
}
