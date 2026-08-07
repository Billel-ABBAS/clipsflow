"use client";

// ============================================================================
// GalleryToolbar — sort / filter / search controls above the gallery grid.
// Ported from VidiaFlow src/components/clipflow/GalleryToolbar.tsx.
// Adaptations : pure helpers import → @/lib/clips/gallery-toolbar ; i18n
// namespace → clips.toolbar. Pure UI : the parent owns the filtered/sorted
// array and re-renders the grid — no server query.
// ============================================================================

import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  applyToolbar,
  DEFAULT_TOOLBAR,
  type AspectFilter,
  type GalleryToolbarValue,
  type SortKey,
  type StatusFilter,
  type ToolbarRow,
} from "@/lib/clips/gallery-toolbar";

// Re-exported for callers that import the helpers off the component module.
export {
  applyToolbar,
  DEFAULT_TOOLBAR,
  type AspectFilter,
  type GalleryToolbarValue,
  type SortKey,
  type StatusFilter,
  type ToolbarRow,
};

export interface GalleryToolbarProps {
  value: GalleryToolbarValue;
  onChange: (next: GalleryToolbarValue) => void;
  totalCount: number;
  filteredCount: number;
}

export function GalleryToolbar({
  value,
  onChange,
  totalCount,
  filteredCount,
}: GalleryToolbarProps) {
  const t = useTranslations("clips.toolbar");
  const isFiltered =
    value.status !== "all" ||
    value.aspect !== "all" ||
    value.search.trim() !== "";

  const update = (patch: Partial<GalleryToolbarValue>) =>
    onChange({ ...value, ...patch });

  return (
    <div
      data-testid="clips-gallery-toolbar"
      className="border-border bg-muted/30 flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs"
    >
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{t("filter_label")}</span>
        <select
          aria-label={t("filter_label")}
          data-testid="toolbar-status"
          value={value.status}
          onChange={(e) => update({ status: e.target.value as StatusFilter })}
          className="border-border bg-background text-foreground rounded-md border px-2 py-1"
        >
          <option value="all">{t("filter_all")}</option>
          <option value="completed">{t("filter_completed")}</option>
          <option value="processing">{t("filter_processing")}</option>
          <option value="failed">{t("filter_failed")}</option>
        </select>
      </label>

      <select
        aria-label="Aspect ratio"
        data-testid="toolbar-aspect"
        value={value.aspect}
        onChange={(e) => update({ aspect: e.target.value as AspectFilter })}
        className="border-border bg-background text-foreground rounded-md border px-2 py-1"
      >
        <option value="all">{t("aspect_all")}</option>
        <option value="9:16">9:16</option>
        <option value="1:1">1:1</option>
        <option value="4:5">4:5</option>
        <option value="16:9">16:9</option>
      </select>

      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{t("sort_label")}</span>
        <select
          aria-label={t("sort_label")}
          data-testid="toolbar-sort"
          value={value.sort}
          onChange={(e) => update({ sort: e.target.value as SortKey })}
          className="border-border bg-background text-foreground rounded-md border px-2 py-1"
        >
          <option value="recent">{t("sort_recent")}</option>
          <option value="oldest">{t("sort_oldest")}</option>
          <option value="hook_desc">{t("sort_hook_desc")}</option>
        </select>
      </label>

      <div className="ml-auto flex items-center gap-2">
        <label className="relative inline-flex items-center">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 h-3 w-3" />
          <input
            type="search"
            aria-label={t("search_aria")}
            data-testid="toolbar-search"
            placeholder={t("search_placeholder")}
            value={value.search}
            onChange={(e) => update({ search: e.target.value })}
            className="border-border bg-background text-foreground placeholder:text-muted-foreground/70 w-40 rounded-md border px-2 py-1 pl-7"
          />
        </label>
        {isFiltered && (
          <button
            type="button"
            data-testid="toolbar-clear"
            onClick={() => onChange(DEFAULT_TOOLBAR)}
            className="border-border bg-background text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
          >
            <X className="h-3 w-3" />
            {t("clear_filters")}
          </button>
        )}
        <span
          className="text-muted-foreground font-mono text-[10px]"
          data-testid="toolbar-count"
        >
          {filteredCount} / {totalCount}
        </span>
      </div>
    </div>
  );
}
