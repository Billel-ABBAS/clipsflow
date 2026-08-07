// ============================================================================
// Tests unitaires — gallery-toolbar.ts
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  applyToolbar,
  DEFAULT_TOOLBAR,
  type GalleryToolbarValue,
  type ToolbarRow,
} from "./gallery-toolbar";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeRow(
  partial: Partial<ToolbarRow> & { id?: string },
): ToolbarRow & { id?: string } {
  return {
    status: "completed",
    aspect_ratio: "9:16",
    style_key: "viral",
    created_at: "2026-01-01T00:00:00Z",
    score: null,
    ...partial,
  };
}

const ROW_COMPLETED = makeRow({
  status: "completed",
  created_at: "2026-06-01T10:00:00Z",
  score: 80,
});
const ROW_PENDING = makeRow({
  status: "pending",
  aspect_ratio: "16:9",
  style_key: "minimal",
  created_at: "2026-06-01T09:00:00Z",
  score: 30,
});
const ROW_PROCESSING = makeRow({
  status: "processing",
  created_at: "2026-06-01T11:00:00Z",
  score: null,
});
const ROW_COMPLETING = makeRow({
  status: "completing",
  created_at: "2026-06-01T12:00:00Z",
  score: null,
});
const ROW_FAILED = makeRow({
  status: "failed",
  aspect_ratio: "1:1",
  style_key: "hormozi",
  created_at: "2026-05-31T08:00:00Z",
  score: 10,
});

const ALL_ROWS = [
  ROW_COMPLETED,
  ROW_PENDING,
  ROW_PROCESSING,
  ROW_COMPLETING,
  ROW_FAILED,
];

// ---------------------------------------------------------------------------
// Filtre statut
// ---------------------------------------------------------------------------
describe("applyToolbar — filtre statut", () => {
  it("status='all' retourne tous les jobs", () => {
    const result = applyToolbar(ALL_ROWS, DEFAULT_TOOLBAR);
    expect(result).toHaveLength(5);
  });

  it("status='completed' retourne seulement completed", () => {
    const tv: GalleryToolbarValue = {
      ...DEFAULT_TOOLBAR,
      status: "completed",
    };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("completed");
  });

  it("status='processing' retourne pending + processing + completing", () => {
    const tv: GalleryToolbarValue = {
      ...DEFAULT_TOOLBAR,
      status: "processing",
    };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(3);
    const statuses = result.map((r) => r.status);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("processing");
    expect(statuses).toContain("completing");
  });

  it("status='failed' retourne seulement failed", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, status: "failed" };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Filtre aspect ratio
// ---------------------------------------------------------------------------
describe("applyToolbar — filtre aspect ratio", () => {
  it("aspect='all' ne filtre pas", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, aspect: "all" };
    expect(applyToolbar(ALL_ROWS, tv)).toHaveLength(5);
  });

  it("aspect='9:16' retourne seulement les rows 9:16", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, aspect: "9:16" };
    const result = applyToolbar(ALL_ROWS, tv);
    // ROW_COMPLETED, ROW_PROCESSING, ROW_COMPLETING sont 9:16 (par défaut)
    for (const r of result) {
      expect(r.aspect_ratio).toBe("9:16");
    }
  });

  it("aspect='1:1' retourne seulement ROW_FAILED", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, aspect: "1:1" };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(1);
    expect(result[0]!.aspect_ratio).toBe("1:1");
  });

  it("aspect='4:5' retourne rien s'il n'y a pas de 4:5", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, aspect: "4:5" };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tri
// ---------------------------------------------------------------------------
describe("applyToolbar — tri", () => {
  it("sort='recent' classe du plus récent au plus ancien", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, sort: "recent" };
    const result = applyToolbar(ALL_ROWS, tv);
    for (let i = 0; i < result.length - 1; i++) {
      const a = new Date(result[i]!.created_at).getTime();
      const b = new Date(result[i + 1]!.created_at).getTime();
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  it("sort='oldest' classe du plus ancien au plus récent", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, sort: "oldest" };
    const result = applyToolbar(ALL_ROWS, tv);
    for (let i = 0; i < result.length - 1; i++) {
      const a = new Date(result[i]!.created_at).getTime();
      const b = new Date(result[i + 1]!.created_at).getTime();
      expect(a).toBeLessThanOrEqual(b);
    }
  });

  it("sort='hook_desc' classe par score décroissant (null en dernier)", () => {
    const tv: GalleryToolbarValue = {
      ...DEFAULT_TOOLBAR,
      sort: "hook_desc",
    };
    const result = applyToolbar(ALL_ROWS, tv);
    // ROW_COMPLETED (80) > ROW_PENDING (30) > ROW_FAILED (10) > null(-1)
    for (let i = 0; i < result.length - 1; i++) {
      const a = result[i]!.score ?? -1;
      const b = result[i + 1]!.score ?? -1;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });
});

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------
describe("applyToolbar — recherche", () => {
  it("search vide ne filtre rien", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, search: "" };
    expect(applyToolbar(ALL_ROWS, tv)).toHaveLength(5);
  });

  it("search espace ne filtre rien (trim)", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, search: "  " };
    expect(applyToolbar(ALL_ROWS, tv)).toHaveLength(5);
  });

  it("search 'viral' retourne seulement les rows avec style_key=viral", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, search: "viral" };
    const result = applyToolbar(ALL_ROWS, tv);
    for (const r of result) {
      expect(r.style_key).toBe("viral");
    }
  });

  it("search 'hormozi' retourne ROW_FAILED", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, search: "hormozi" };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(1);
    expect(result[0]!.style_key).toBe("hormozi");
  });

  it("search sur aspect_ratio '16:9'", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, search: "16:9" };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(1);
    expect(result[0]!.aspect_ratio).toBe("16:9");
  });

  it("search insensible à la casse", () => {
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, search: "VIRAL" };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Combinaisons
// ---------------------------------------------------------------------------
describe("applyToolbar — combinaisons filtre + tri", () => {
  it("status=completed + sort=hook_desc", () => {
    const tv: GalleryToolbarValue = {
      status: "completed",
      aspect: "all",
      sort: "hook_desc",
      search: "",
    };
    const result = applyToolbar(ALL_ROWS, tv);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(80);
  });

  it("ne mute pas le tableau d'entrée", () => {
    const input = [...ALL_ROWS];
    const tv: GalleryToolbarValue = { ...DEFAULT_TOOLBAR, sort: "oldest" };
    applyToolbar(input, tv);
    // L'ordre original n'est pas perturbé
    expect(input[0]).toBe(ROW_COMPLETED);
  });
});
