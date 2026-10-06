"use client";

// ============================================================================
// ClipsGallery — grid of the user's clips with status badges + actions.
// Ported from VidiaFlow src/components/clipflow/ClipsGallery.tsx.
// Adaptations :
//   - Row shape follows the ClipsFlow `clips` table : output_url → video_url,
//     poster_url → thumbnail_url, hook_score → score ; episode title joined
//     server-side (episodes.title) is displayed on each card.
//   - NEW : VTT download link next to the MP4 download (captions_vtt_url).
//   - REMOVED : delete / bulk-delete actions (no DELETE API in P1) and the
//     SampleClipsStrip empty-state embeds.
//   - RetryClipButton receives the full retry seed (P1 re-POSTs
//     /api/clips/jobs — no dedicated retry route).
//   - i18n namespace → clips ; status colours kept identical to source.
// ============================================================================

import {
  AlertCircle,
  CheckCircle,
  Clock,
  HelpCircle,
  Loader2,
  Plus,
  Scissors,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { buttonVariants } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { OverlayElement } from "@/lib/clips/overlays";
import type { ClipStatus, SubtitleCustomizations } from "@/lib/clips/types";
import { cn } from "@/lib/utils";

import {
  ClipLibraryControls,
  type ClipCollectionOption,
} from "./ClipLibraryControls";
import { ReclipMenu } from "./ReclipMenu";
import { RetryClipButton } from "./RetryClipButton";
import { ShareButton } from "./ShareButton";
import { YouTubePublishControl } from "./YouTubePublishControl";

// ---- types -----------------------------------------------------------------

export interface GalleryClipRow {
  id: string;
  episode_id: string;
  status: ClipStatus;
  style_key: string | null;
  aspect_ratio: string | null;
  language: string | null;
  start_seconds: number;
  end_seconds: number;
  customizations: SubtitleCustomizations | null;
  overlays: OverlayElement[] | null;
  video_url: string | null;
  /** Signed URL with Content-Disposition: attachment for MP4 download. */
  video_download_url: string | null;
  /** Server-extracted JPEG poster (signed URL). Null in P1 — the
   *  `#t` seek fallback in <video> covers the preview. */
  thumbnail_url: string | null;
  /** Signed URL for the WebVTT sidecar — surfaced as a download link. */
  captions_vtt_url: string | null;
  /** Signed URL with Content-Disposition: attachment for VTT download. */
  captions_vtt_download_url: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  /** Heuristic 0-100 hook score. Hidden when null. */
  score: number | null;
  title_override: string | null;
  is_favorite: boolean;
  collection_id: string | null;
  /** Joined episodes.title — card context line. */
  episode_title: string | null;
}

export interface ClipsGalleryProps {
  clips: GalleryClipRow[];
  /** Hide the sort/filter/search toolbar (embedded recent strip). */
  hideToolbar?: boolean;
  /** Show private library actions even when the toolbar is hidden. */
  showLibraryControls?: boolean;
  collections?: ClipCollectionOption[];
}

// ---- helpers ---------------------------------------------------------------

type TFn = ReturnType<typeof useTranslations<"clips">>;

function StatusBadge({ status, t }: { status: ClipStatus; t: TFn }) {
  const map: Record<
    ClipStatus,
    { icon: React.ReactNode; labelKey: string; cls: string }
  > = {
    pending: {
      icon: <Clock className="h-3 w-3" />,
      labelKey: "gallery_status_pending",
      cls: "text-muted-foreground",
    },
    processing: {
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      labelKey: "gallery_status_processing",
      cls: "text-yellow-500",
    },
    completing: {
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
      labelKey: "gallery_status_completing",
      cls: "text-yellow-500",
    },
    completed: {
      icon: <CheckCircle className="h-3 w-3" />,
      labelKey: "gallery_status_completed",
      cls: "text-emerald-500",
    },
    failed: {
      icon: <AlertCircle className="h-3 w-3" />,
      labelKey: "gallery_status_failed",
      cls: "text-red-500",
    },
  };
  const { icon, labelKey, cls } = map[status] ?? map.pending;
  return (
    <span className={cn("flex items-center gap-1 text-xs font-medium", cls)}>
      {icon}
      {t(labelKey)}
    </span>
  );
}

// ---- empty state -----------------------------------------------------------

function EmptyState({ t }: { t: TFn }) {
  return (
    <div
      className="border-border flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed py-12 text-center"
      data-testid="clips-empty-state"
    >
      <div className="bg-primary/10 flex h-14 w-14 items-center justify-center rounded-xl">
        <Scissors className="text-primary h-7 w-7" />
      </div>
      <div className="space-y-1">
        <p className="text-foreground font-semibold">
          {t("gallery_empty_title")}
        </p>
        <p className="text-muted-foreground text-sm">
          {t("gallery_empty_subtitle")}
        </p>
      </div>
      <Link href="/clips/new" className={cn(buttonVariants({ size: "lg" }))}>
        <Plus className="mr-1.5 h-4 w-4" />
        {t("new_clip_cta")}
      </Link>
    </div>
  );
}

// ---- gallery ---------------------------------------------------------------

export function ClipsGallery({
  clips,
  hideToolbar = false,
  showLibraryControls = !hideToolbar,
  collections = [],
}: ClipsGalleryProps) {
  const t = useTranslations("clips");
  const locale = useLocale();
  const [selectedForDownload, setSelectedForDownload] = useState<Set<string>>(
    new Set(),
  );
  const downloadableIds = useMemo(
    () =>
      new Set(
        clips
          .filter((clip) => clip.status === "completed" && clip.video_url)
          .map((clip) => clip.id),
      ),
    [clips],
  );
  const selectedDownloadIds = [...selectedForDownload].filter((id) =>
    downloadableIds.has(id),
  );
  const bulkDownloadHref =
    selectedDownloadIds.length >= 2
      ? `/api/clips/download/bulk?clip_ids=${encodeURIComponent(selectedDownloadIds.join(","))}`
      : null;

  const formatDate = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  if (clips.length === 0) {
    return <EmptyState t={t} />;
  }

  return (
    <div className="space-y-4">
      {showLibraryControls && selectedDownloadIds.length > 0 ? (
        <div className="border-border bg-muted/20 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
          <span className="text-muted-foreground text-sm" aria-live="polite">
            {t("gallery_download_selection_count", {
              count: selectedDownloadIds.length,
            })}
          </span>
          <div className="flex items-center gap-2">
            {bulkDownloadHref ? (
              <a
                href={bulkDownloadHref}
                className={cn(buttonVariants({ size: "sm" }))}
              >
                {t("gallery_download_selected")}
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => setSelectedForDownload(new Set())}
              className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
            >
              {t("gallery_clear_download_selection")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {clips.map((clip) => (
          <div
            key={clip.id}
            className="border-border bg-card flex flex-col gap-3 overflow-hidden rounded-xl border p-4"
          >
            {showLibraryControls &&
            clip.status === "completed" &&
            clip.video_url ? (
              <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedForDownload.has(clip.id)}
                  onChange={(event) => {
                    setSelectedForDownload((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(clip.id);
                      else next.delete(clip.id);
                      return next;
                    });
                  }}
                  className="accent-primary size-4"
                  aria-label={t("gallery_select_for_download")}
                />
                {t("gallery_select_for_download")}
              </label>
            ) : null}
            {/* Preview / placeholder */}
            <div className="from-card to-muted relative aspect-video w-full overflow-hidden rounded-lg bg-gradient-to-br">
              {clip.status === "completed" && clip.video_url ? (
                // preload="metadata" + seek-to-2s poster strategy bounds
                // the gallery-load bandwidth (~50 KB/card). thumbnail_url
                // is used as the poster when the pipeline produced one.
                <video
                  src={clip.video_url}
                  poster={clip.thumbnail_url ?? undefined}
                  controls
                  playsInline
                  preload="metadata"
                  muted
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    const target = Math.min(2, (v.duration || 30) * 0.1);
                    try {
                      v.currentTime = target;
                    } catch {
                      /* some browsers reject seek before duration known */
                    }
                  }}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <StatusBadge status={clip.status} t={t} />
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <StatusBadge status={clip.status} t={t} />
                <div className="flex items-center gap-1.5">
                  {/* Hook score badge — hidden when null. */}
                  {typeof clip.score === "number" && (
                    <span
                      className={cn(
                        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                        clip.score >= 80
                          ? "bg-emerald-500/15 text-emerald-600"
                          : clip.score >= 50
                            ? "bg-amber-500/15 text-amber-600"
                            : "bg-red-500/15 text-red-600",
                      )}
                      title={t("gallery_hook_score_tooltip")}
                    >
                      {t("gallery_hook_score_label")} {clip.score}
                      <HelpCircle
                        className="h-2.5 w-2.5 opacity-70"
                        aria-hidden="true"
                      />
                    </span>
                  )}
                  {clip.aspect_ratio && (
                    <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 font-mono text-[10px]">
                      {clip.aspect_ratio}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-foreground truncate text-sm font-medium">
                {clip.title_override ||
                  clip.episode_title ||
                  t("untitled_clip")}
              </p>
              {clip.title_override && clip.episode_title && (
                <p
                  className="text-muted-foreground truncate text-xs"
                  title={clip.episode_title}
                >
                  {t("source_label")}: {clip.episode_title}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {formatDate(clip.created_at)}
              </p>
              {clip.status === "failed" && clip.error_message && (
                <p className="text-xs text-red-500">
                  {clip.error_message.startsWith("no_speech_detected:")
                    ? t("errors.no_speech_detected")
                    : clip.error_message.startsWith("source_too_large:")
                      ? t("errors.source_too_large")
                      : clip.error_message.startsWith("invalid_source_url:")
                        ? t("errors.invalid_source_url")
                        : t("errors.generic_failure")}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              {clip.status === "completed" && clip.video_url && (
                <>
                  {clip.video_download_url && (
                    <a
                      href={clip.video_download_url}
                      download
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                        "flex-1",
                      )}
                    >
                      {t("gallery_download")}
                    </a>
                  )}
                  {clip.captions_vtt_download_url && (
                    <a
                      href={clip.captions_vtt_download_url}
                      download
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                      )}
                      title={t("gallery_download_vtt")}
                    >
                      {t("gallery_download_vtt")}
                    </a>
                  )}
                  <ShareButton
                    clipId={clip.id}
                    title={
                      clip.title_override || clip.episode_title || "ClipsFlow"
                    }
                  />
                  <YouTubePublishControl
                    clipId={clip.id}
                    clipTitle={
                      clip.title_override || clip.episode_title || "ClipsFlow"
                    }
                  />
                  <ReclipMenu
                    clipId={clip.id}
                    currentAspect={clip.aspect_ratio}
                  />
                </>
              )}
              {clip.status === "failed" && <RetryClipButton clipId={clip.id} />}
            </div>
            {showLibraryControls && (
              <ClipLibraryControls
                clipId={clip.id}
                title={clip.title_override}
                isFavorite={clip.is_favorite}
                collectionId={clip.collection_id}
                collections={collections}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
