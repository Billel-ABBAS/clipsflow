"use client";

// ============================================================================
// ClipStudio — 4-step clip creation studio.
// Ported from VidiaFlow src/components/clipflow/SubtitleStudio.tsx (2 400
// LOC) and substantially slimmed for ClipsFlow P1 :
//
//   Step 1 — Source : Upload (UploadDropzone → POST /api/clips/upload-init →
//            signed PUT with progress → episode_id) / URL (https + title) /
//            existing Episode (select fed by server props)
//   Step 2 — Segment : start/end mm:ss (end > start, ≤ 180 s) + aspect
//            ratio + subtitle language (lib locales.ts)
//   Step 3 — Style : PresetGrid (12 presets → hydrate defaults) + 15
//            StyleCard grid
//   Step 4 — Customizations + overlays : ColorPicker / FontPicker /
//            PositionPicker + the 4 overlay toggles (title_card,
//            lower_third, stat_callout, cta_outro)
//
// Submit → POST /api/clips/jobs → 202 → useClipJobStatus(clip_id)
// (Realtime + polling fallback) → terminal → toast + redirect /clips.
// 402 → inline quota message.
//
// REMOVED vs source : brand-kit step + selector, resolution tier 2K/4K,
// browser-burn path (ffmpeg.wasm + capability detect + finalize),
// idempotency-key header, demo mode, inline LOCALES_OPTIONS (imported from
// @/lib/clips/locales), client-error reporting endpoint.
// `?dup=` seeding is preserved : the page server-resolves the original
// `clips` row and passes `initialDuplicateSeed` — state initialisers
// hydrate from it directly (no one-shot effect needed).
// ============================================================================

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useClipJobStatus,
  type ClipJobStatusState,
} from "@/hooks/use-clip-job-status";
import { useRouter } from "@/i18n/navigation";
import { LOCALES_OPTIONS } from "@/lib/clips/locales";
import type { PresetBundle, PresetCode } from "@/lib/clips/preset-defaults";
import type { Plan } from "@/lib/clips/quota";
import {
  ASPECT_RATIOS,
  STYLE_KEYS,
  type AspectRatio,
  type StyleKey,
  type SubtitleCustomizations,
} from "@/lib/clips/types";
import { cn } from "@/lib/utils";

import { ClipsGallery, type GalleryClipRow } from "./ClipsGallery";
import { ColorPicker } from "./ColorPicker";
import { FontPicker } from "./FontPicker";
import { PositionPicker, type CornerPosition } from "./PositionPicker";
import { PresetGrid } from "./PresetGrid";
import { QuotaIndicator } from "./QuotaIndicator";
import { StyleCard } from "./StyleCard";
import { UploadDropzone, type UploadState } from "./UploadDropzone";

// ---- types ----------------------------------------------------------------

/** Single segment — multi-segment deferred to V2 (same as source). */
interface SingleSegment {
  startTs: string; // mm:ss
  endTs: string; // mm:ss
}

interface TitleCardFormState {
  enabled: boolean;
  text: string;
  subtitle: string;
  startSec: number;
  endSec: number;
}

interface LowerThirdFormState {
  enabled: boolean;
  name: string;
  role: string;
  startSec: number;
  endSec: number;
}

type StatCalloutPosition = CornerPosition;

interface StatCalloutFormState {
  enabled: boolean;
  value: string;
  label: string;
  startSec: number;
  endSec: number;
  position: StatCalloutPosition;
}

interface CtaOutroFormState {
  enabled: boolean;
  text: string;
  startSec: number;
  endSec: number;
}

// Caps mirror the Zod schema in /api/clips/jobs (same numbers as source).
const TITLE_CARD_TEXT_MAX = 60;
const TITLE_CARD_SUBTITLE_MAX = 80;
const LOWER_THIRD_NAME_MAX = 40;
const LOWER_THIRD_ROLE_MAX = 40;
const STAT_CALLOUT_VALUE_MAX = 20;
const STAT_CALLOUT_LABEL_MAX = 40;
const CTA_OUTRO_TEXT_MAX = 60;

/** Hard cap on the clip window — MUST stay aligned with MAX_CLIP_SECONDS
 *  in /api/clips/jobs (and MAX_SEGMENT_SECONDS in run-job.ts). */
const MAX_CLIP_SECONDS = 180;

const SOURCE_INPUT_TABS = ["upload", "url", "episode"] as const;
type SourceTab = (typeof SOURCE_INPUT_TABS)[number];

/** Episode option fed by the server page (max 30 rows). */
export interface EpisodeOption {
  id: string;
  title: string;
  source_type: string;
  created_at: string;
}

/** `?dup=<clipId>` server-resolved seed (original clips row). */
export interface DuplicateSeed {
  episodeId: string;
  startSeconds: number;
  endSeconds: number;
  aspectRatio: string | null;
  styleKey: string | null;
  language: string | null;
}

export interface ClipStudioProps {
  episodes: EpisodeOption[];
  /** Recent clips strip rendered below the form. Hidden when empty. */
  recentClips: GalleryClipRow[];
  plan: Plan;
  secondsUsed: number;
  secondsLimit: number;
  resetAt: string | null;
  initialDuplicateSeed?: DuplicateSeed | null;
}

// ---- helpers ---------------------------------------------------------------

const HTTPS_RE = /^https:\/\/.+/i;

function mmssToSeconds(mmss: string): number {
  const parts = mmss.split(":").map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) return 0;
  const [mm, ss] = parts;
  return mm * 60 + ss;
}

function secondsToMmss(s: number): string {
  const safe = Math.max(0, Math.round(s));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** Returns an i18n key (relative to `clips`) or null when valid. */
function segmentErrorKey(segment: SingleSegment): string | null {
  const start = mmssToSeconds(segment.startTs);
  const end = mmssToSeconds(segment.endTs);
  if (end <= start) return "seg_error";
  if (end - start > MAX_CLIP_SECONDS) return "seg_error_max";
  return null;
}

/** Clamp a numeric input to `[0, max]`. NaN → 0. */
function clampSec(v: number, max: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > max) return max;
  return v;
}

/** Derive the episode title from the uploaded file name. */
function titleFromFilename(name: string): string {
  const stripped = name.replace(/\.[^.]+$/, "").trim();
  return (stripped.length > 0 ? stripped : "Untitled upload").slice(0, 200);
}

// ---- main component --------------------------------------------------------

export function ClipStudio({
  episodes,
  recentClips,
  plan,
  secondsUsed,
  secondsLimit,
  resetAt,
  initialDuplicateSeed = null,
}: ClipStudioProps) {
  const t = useTranslations("clips");
  const locale = useLocale();
  const router = useRouter();
  const seed = initialDuplicateSeed;

  // Step 1 — source. `?dup=` seeds the Episode tab with the original
  // episode (the source media is re-used ; a fresh render is enqueued).
  const [sourceTab, setSourceTab] = useState<SourceTab>(
    seed ? "episode" : "upload",
  );
  const [uploadState, setUploadState] = useState<UploadState>({
    status: "idle",
  });
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [urlErrorKey, setUrlErrorKey] = useState<string | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>(
    seed?.episodeId ?? "",
  );

  // Step 2 — segment + aspect + language.
  const [segment, setSegment] = useState<SingleSegment>(() =>
    seed
      ? {
          startTs: secondsToMmss(seed.startSeconds),
          endTs: secondsToMmss(
            Math.max(seed.startSeconds + 1, seed.endSeconds),
          ),
        }
      : { startTs: "00:00", endTs: "00:30" },
  );
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(() =>
    seed?.aspectRatio &&
    (ASPECT_RATIOS as readonly string[]).includes(seed.aspectRatio)
      ? (seed.aspectRatio as AspectRatio)
      : "9:16",
  );
  const [language, setLanguage] = useState<string>(
    () => seed?.language ?? locale,
  );

  // Step 3 — style + preset.
  const [styleKey, setStyleKey] = useState<StyleKey>(() =>
    seed?.styleKey && (STYLE_KEYS as readonly string[]).includes(seed.styleKey)
      ? (seed.styleKey as StyleKey)
      : "viral",
  );
  const [activePreset, setActivePreset] = useState<PresetCode | null>(null);

  // Step 4 — customizations.
  const [customizations, setCustomizations] = useState<SubtitleCustomizations>(
    {},
  );

  // Step 4 — overlays. 4 form states unified under one reducer (source
  // pattern) ; wrappers preserve the `(prev) => next` setter signature.
  type OverlayForms = {
    titleCard: TitleCardFormState;
    lowerThird: LowerThirdFormState;
    statCallout: StatCalloutFormState;
    ctaOutro: CtaOutroFormState;
  };
  type OverlayFormsAction =
    | {
        type: "titleCard";
        value:
          | TitleCardFormState
          | ((prev: TitleCardFormState) => TitleCardFormState);
      }
    | {
        type: "lowerThird";
        value:
          | LowerThirdFormState
          | ((prev: LowerThirdFormState) => LowerThirdFormState);
      }
    | {
        type: "statCallout";
        value:
          | StatCalloutFormState
          | ((prev: StatCalloutFormState) => StatCalloutFormState);
      }
    | {
        type: "ctaOutro";
        value:
          | CtaOutroFormState
          | ((prev: CtaOutroFormState) => CtaOutroFormState);
      };
  function overlayFormsReducer(
    state: OverlayForms,
    action: OverlayFormsAction,
  ): OverlayForms {
    const prev = state[action.type];
    const next =
      typeof action.value === "function"
        ? (action.value as (p: typeof prev) => typeof prev)(prev)
        : action.value;
    return { ...state, [action.type]: next };
  }
  const [overlayForms, dispatchOverlays] = useReducer(overlayFormsReducer, {
    titleCard: {
      enabled: false,
      text: "",
      subtitle: "",
      startSec: 0,
      endSec: 2,
    },
    lowerThird: { enabled: false, name: "", role: "", startSec: 1, endSec: 5 },
    statCallout: {
      enabled: false,
      value: "",
      label: "",
      startSec: 2,
      endSec: 5,
      position: "top-right",
    },
    ctaOutro: { enabled: false, text: "", startSec: 0, endSec: 0 },
  });
  const { titleCard, lowerThird, statCallout, ctaOutro } = overlayForms;
  const setTitleCard = useCallback(
    (
      value:
        | TitleCardFormState
        | ((prev: TitleCardFormState) => TitleCardFormState),
    ) => dispatchOverlays({ type: "titleCard", value }),
    [],
  );
  const setLowerThird = useCallback(
    (
      value:
        | LowerThirdFormState
        | ((prev: LowerThirdFormState) => LowerThirdFormState),
    ) => dispatchOverlays({ type: "lowerThird", value }),
    [],
  );
  const setStatCallout = useCallback(
    (
      value:
        | StatCalloutFormState
        | ((prev: StatCalloutFormState) => StatCalloutFormState),
    ) => dispatchOverlays({ type: "statCallout", value }),
    [],
  );
  const setCtaOutro = useCallback(
    (
      value:
        | CtaOutroFormState
        | ((prev: CtaOutroFormState) => CtaOutroFormState),
    ) => dispatchOverlays({ type: "ctaOutro", value }),
    [],
  );

  // Computed clip duration drives auto-defaults for the cta_outro window.
  const clipDurationSec = Math.max(
    1,
    mmssToSeconds(segment.endTs) - mmssToSeconds(segment.startTs),
  );

  // CTA outro window auto-anchors to the last 2 s at toggle-on time.
  const handleCtaOutroChange = useCallback(
    (s: CtaOutroFormState) => {
      const justEnabled = s.enabled && !ctaOutro.enabled;
      if (justEnabled && s.startSec === 0 && s.endSec === 0) {
        setCtaOutro({
          ...s,
          startSec: Math.max(0, clipDurationSec - 2),
          endSec: clipDurationSec,
        });
        return;
      }
      setCtaOutro(s);
    },
    [ctaOutro.enabled, clipDurationSec, setCtaOutro],
  );

  const applyPreset = useCallback(
    (preset: PresetBundle) => {
      const d = preset.defaults;
      if (d.aspectRatio) setAspectRatio(d.aspectRatio);
      if (d.styleKey) setStyleKey(d.styleKey);
      if (d.position) {
        setCustomizations((prev) => ({ ...prev, position: d.position }));
      }
      if (d.segmentEndTs) {
        setSegment((prev) => {
          const next = { ...prev, endTs: d.segmentEndTs! };
          setSegmentError(segmentErrorKey(next));
          return next;
        });
      }
      if (d.overlayCounter) {
        // Hormozi-style presets auto-enable a stat-callout count-up.
        setStatCallout((prev) => ({
          ...prev,
          enabled: true,
          value: prev.value || "100K",
          label: prev.label || t("overlays.stat_callout.preset_default_label"),
          position: "top-right",
        }));
      }
      if (d.overlayCta) {
        // LinkedIn Pro preset auto-enables the CTA outro overlay.
        setCtaOutro((prev) => ({
          ...prev,
          enabled: true,
          text: prev.text || t("overlays.cta_outro.preset_default_text"),
        }));
      }
      setActivePreset(preset.code);
    },
    [setCtaOutro, setStatCallout, t],
  );
  const resetPreset = useCallback(() => setActivePreset(null), []);

  // ─── Submission + realtime status ──────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [quotaRemaining, setQuotaRemaining] = useState<number | null>(null);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const clipStatus = useClipJobStatus(activeClipId);
  // Deferred resolver — set by handleSubmit before awaiting, called by the
  // effect below when the row goes terminal (source pattern).
  const pendingTerminalResolverRef = useRef<
    ((s: ClipJobStatusState) => void) | null
  >(null);

  useEffect(() => {
    if (!activeClipId) return;
    if (clipStatus.status !== "completed" && clipStatus.status !== "failed") {
      return;
    }
    const resolver = pendingTerminalResolverRef.current;
    if (!resolver) return;
    pendingTerminalResolverRef.current = null;
    resolver(clipStatus);
    // Clear the clipId so the hook unmounts the channel cleanly (post-
    // resolve so the terminal state reached the awaiting caller first).
    setActiveClipId(null);
  }, [activeClipId, clipStatus]);

  const isPro = plan === "pro" || plan === "studio";
  const isStudio = plan === "studio";

  const handleUrlChange = useCallback((val: string) => {
    setSourceUrl(val);
    setUrlErrorKey(
      val && !HTTPS_RE.test(val) ? "source_url_error_https" : null,
    );
  }, []);

  const handleSegmentChange = useCallback(
    (field: keyof SingleSegment, val: string) => {
      setSegment((prev) => {
        const next = { ...prev, [field]: val };
        setSegmentError(segmentErrorKey(next));
        return next;
      });
    },
    [],
  );

  // Upload pipeline : upload-init → signed PUT (XHR for real progress —
  // `uploadToSignedUrl` has no progress callback, the PUT below targets
  // the exact same signed endpoint with the token embedded in the URL).
  const handleFileUpload = useCallback(async (file: File) => {
    setUploadState({ status: "uploading", progress: 0, filename: file.name });
    try {
      const initRes = await fetch("/api/clips/upload-init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: file.name,
          mime: file.type,
          title: titleFromFilename(file.name),
        }),
      });
      if (!initRes.ok) {
        setUploadState({ status: "error", errorKey: "upload_error_failed" });
        return;
      }
      const { data } = (await initRes.json()) as {
        data: {
          episode_id: string;
          upload_url: string;
          token: string;
          storage_path: string;
        };
      };

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", data.upload_url, true);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setUploadState({
              status: "uploading",
              progress: pct,
              filename: file.name,
            });
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`PUT failed: ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error("XHR error"));
        xhr.send(file);
      });

      setUploadState({
        status: "done",
        filename: file.name,
        episodeId: data.episode_id,
      });
    } catch {
      setUploadState({ status: "error", errorKey: "upload_error_failed" });
    }
  }, []);

  // Source readiness per tab — drives the submit button disabled state.
  const sourceReady =
    sourceTab === "upload"
      ? uploadState.status === "done"
      : sourceTab === "url"
        ? HTTPS_RE.test(sourceUrl) && sourceTitle.trim().length > 0
        : selectedEpisodeId.length > 0;

  const handleSubmit = async () => {
    const segError = segmentErrorKey(segment);
    if (segError) {
      setSegmentError(segError);
      return;
    }
    if (!sourceReady) return;

    setSubmitting(true);
    setQuotaRemaining(null);

    try {
      // Build overlays array — only enabled sub-blocks with their required
      // text present. Omitted entirely when empty (optional API field).
      const overlaysPayload: Record<string, unknown>[] = [];
      if (titleCard.enabled && titleCard.text.trim().length > 0) {
        overlaysPayload.push({
          type: "title_card",
          text: titleCard.text.trim().slice(0, TITLE_CARD_TEXT_MAX),
          ...(titleCard.subtitle.trim().length > 0
            ? {
                subtitle: titleCard.subtitle
                  .trim()
                  .slice(0, TITLE_CARD_SUBTITLE_MAX),
              }
            : {}),
          startSec: Math.max(0, titleCard.startSec),
          endSec: Math.max(titleCard.startSec + 0.1, titleCard.endSec),
        });
      }
      if (lowerThird.enabled && lowerThird.name.trim().length > 0) {
        overlaysPayload.push({
          type: "lower_third",
          name: lowerThird.name.trim().slice(0, LOWER_THIRD_NAME_MAX),
          ...(lowerThird.role.trim().length > 0
            ? { role: lowerThird.role.trim().slice(0, LOWER_THIRD_ROLE_MAX) }
            : {}),
          startSec: Math.max(0, lowerThird.startSec),
          endSec: Math.max(lowerThird.startSec + 0.1, lowerThird.endSec),
        });
      }
      if (statCallout.enabled && statCallout.value.trim().length > 0) {
        overlaysPayload.push({
          type: "stat_callout",
          value: statCallout.value.trim().slice(0, STAT_CALLOUT_VALUE_MAX),
          ...(statCallout.label.trim().length > 0
            ? {
                label: statCallout.label
                  .trim()
                  .slice(0, STAT_CALLOUT_LABEL_MAX),
              }
            : {}),
          startSec: Math.max(0, statCallout.startSec),
          endSec: Math.max(statCallout.startSec + 0.1, statCallout.endSec),
          position: statCallout.position,
        });
      }
      if (ctaOutro.enabled && ctaOutro.text.trim().length > 0) {
        overlaysPayload.push({
          type: "cta_outro",
          text: ctaOutro.text.trim().slice(0, CTA_OUTRO_TEXT_MAX),
          startSec: Math.max(0, ctaOutro.startSec),
          endSec: Math.max(ctaOutro.startSec + 0.1, ctaOutro.endSec),
        });
      }

      // episode_id XOR source — exactly one, per the API contract.
      const episodeId =
        sourceTab === "upload" && uploadState.status === "done"
          ? uploadState.episodeId
          : sourceTab === "episode"
            ? selectedEpisodeId
            : null;

      const body: Record<string, unknown> = {
        ...(episodeId
          ? { episode_id: episodeId }
          : {
              source: {
                url: sourceUrl.trim(),
                title: sourceTitle.trim().slice(0, 200),
              },
            }),
        start_seconds: mmssToSeconds(segment.startTs),
        end_seconds: mmssToSeconds(segment.endTs),
        style_key: styleKey,
        aspect_ratio: aspectRatio,
        language,
      };
      if (Object.keys(customizations).length > 0) {
        body.customizations = customizations;
      }
      if (overlaysPayload.length > 0) body.overlays = overlaysPayload;

      const res = await fetch("/api/clips/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));

      if (res.status === 402) {
        const remaining =
          typeof json.remaining === "number" ? json.remaining : 0;
        setQuotaRemaining(remaining);
        toast.error(t("quota_exceeded", { remaining }));
        return;
      }
      if (res.status !== 202 || !json?.data?.clip_id) {
        toast.error(
          typeof json.error === "string" ? json.error : t("submit_error"),
        );
        return;
      }

      const clipId: string = json.data.clip_id;

      // Await the terminal status via the Realtime hook (+ its 5 s polling
      // fallback). 6-min cap as the user-facing safety net : the cron's
      // stuck-job sweep marks abandoned rows failed server-side anyway.
      const MAX_WAIT_MS = 6 * 60 * 1000;
      const terminal = await new Promise<ClipJobStatusState | "timeout">(
        (resolve) => {
          const timeoutId = setTimeout(() => {
            // Clear the resolver so a late event doesn't double-resolve.
            pendingTerminalResolverRef.current = null;
            setActiveClipId(null);
            resolve("timeout");
          }, MAX_WAIT_MS);

          pendingTerminalResolverRef.current = (state) => {
            clearTimeout(timeoutId);
            resolve(state);
          };

          // Mount the realtime channel ; the effect above fires the
          // resolver as soon as clipStatus turns terminal.
          setActiveClipId(clipId);
        },
      );

      if (terminal === "timeout") {
        toast.error(t("poll_timeout"));
        return;
      }
      if (terminal.status === "completed") {
        toast.success(t("submit_success"));
        router.push("/clips");
        // Invalidate the RSC payload cache for /clips so the freshly-
        // completed clip appears without a hard reload.
        router.refresh();
        return;
      }
      toast.error(terminal.errorMessage ?? t("submit_error"));
    } catch {
      toast.error(t("submit_error_network"));
    } finally {
      setSubmitting(false);
    }
  };

  const waitingStatus =
    submitting && activeClipId && clipStatus.status !== "idle"
      ? clipStatus.status
      : null;

  return (
    <div className="mx-auto max-w-5xl space-y-8 py-6">
      <h1 className="text-foreground text-2xl font-bold">
        {t("studio_title")}
      </h1>

      {/* ─── Step 1 : Source ─────────────────────────────────────────── */}
      <StepSection number={1} title={t("step_source")}>
        {/* Tab switcher */}
        <div className="border-border bg-muted flex gap-1 rounded-lg border p-1">
          {SOURCE_INPUT_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setSourceTab(tab)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                sourceTab === tab
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(
                tab === "upload"
                  ? "tab_upload"
                  : tab === "url"
                    ? "tab_url"
                    : "tab_episode",
              )}
            </button>
          ))}
        </div>

        {sourceTab === "upload" && (
          <UploadDropzone
            uploadState={uploadState}
            onFile={handleFileUpload}
            onValidationError={(errorKey) =>
              setUploadState({ status: "error", errorKey })
            }
            onReset={() => setUploadState({ status: "idle" })}
          />
        )}

        {sourceTab === "url" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="clips-source-url"
                className="text-foreground text-sm font-medium"
              >
                {t("source_url_label")}
              </label>
              <Input
                id="clips-source-url"
                type="url"
                placeholder={t("source_url_placeholder")}
                value={sourceUrl}
                onChange={(e) => handleUrlChange(e.target.value)}
                aria-invalid={!!urlErrorKey}
                aria-describedby={
                  urlErrorKey ? "clips-source-url-error" : undefined
                }
                className="w-full"
              />
              {urlErrorKey && (
                <p
                  id="clips-source-url-error"
                  className="text-destructive text-xs"
                  role="alert"
                >
                  {t(urlErrorKey)}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {t("source_url_hint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="clips-source-title"
                className="text-foreground text-sm font-medium"
              >
                {t("source_title_label")}
              </label>
              <Input
                id="clips-source-title"
                placeholder={t("source_title_placeholder")}
                value={sourceTitle}
                onChange={(e) => setSourceTitle(e.target.value)}
                maxLength={200}
                className="w-full"
              />
            </div>
          </div>
        )}

        {sourceTab === "episode" &&
          (episodes.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("episode_empty")}
            </p>
          ) : (
            <div className="space-y-1.5">
              <label
                htmlFor="clips-episode-select"
                className="text-foreground text-sm font-medium"
              >
                {t("episode_select_label")}
              </label>
              <select
                id="clips-episode-select"
                value={selectedEpisodeId}
                onChange={(e) => setSelectedEpisodeId(e.target.value)}
                className="border-border bg-card text-foreground focus:ring-ring w-full rounded-md border px-2.5 py-1.5 text-sm focus:ring-2 focus:outline-none"
              >
                <option value="">{t("episode_select_placeholder")}</option>
                {episodes.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.title}
                  </option>
                ))}
              </select>
            </div>
          ))}
      </StepSection>

      {/* ─── Step 2 : Segment ────────────────────────────────────────── */}
      <StepSection number={2} title={t("step_segment")}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="seg-start"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("seg_start_label")}
              </label>
              <Input
                id="seg-start"
                value={segment.startTs}
                onChange={(e) => handleSegmentChange("startTs", e.target.value)}
                placeholder="mm:ss"
                className="w-24 font-mono text-sm"
                maxLength={5}
              />
            </div>
            <span className="text-muted-foreground mt-5">{"→"}</span>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="seg-end"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("seg_end_label")}
              </label>
              <Input
                id="seg-end"
                value={segment.endTs}
                onChange={(e) => handleSegmentChange("endTs", e.target.value)}
                placeholder="mm:ss"
                className="w-24 font-mono text-sm"
                maxLength={5}
              />
            </div>
          </div>
          {segmentError && (
            <p className="text-destructive text-xs" role="alert">
              {t(segmentError)}
            </p>
          )}

          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="clips-aspect"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("aspect_label")}
              </label>
              <select
                id="clips-aspect"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                className="border-border bg-card text-foreground focus:ring-ring rounded-md border px-2.5 py-1.5 text-sm focus:ring-2 focus:outline-none"
              >
                {ASPECT_RATIOS.map((r) => (
                  <option key={r} value={r}>
                    {r} — {t(`aspect_hint_${r.replace(":", "_")}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="clips-lang"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("lang_label")}
              </label>
              <select
                id="clips-lang"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="border-border bg-card text-foreground focus:ring-ring rounded-md border px-2.5 py-1.5 text-sm focus:ring-2 focus:outline-none"
              >
                {LOCALES_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </StepSection>

      {/* ─── Step 3 : Style (presets + 15 style cards) ───────────────── */}
      <StepSection number={3} title={t("step_style")}>
        <PresetGrid
          selectedCode={activePreset}
          plan={plan}
          onSelect={applyPreset}
          onReset={resetPreset}
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {STYLE_KEYS.map((key) => (
            <StyleCard
              key={key}
              styleKey={key}
              selected={styleKey === key}
              enabled={isPro || key === "viral"}
              onSelect={() => setStyleKey(key)}
              proLockedLabel={t("style_pro_locked")}
            />
          ))}
        </div>
        {!isPro && (
          <p className="text-muted-foreground text-xs">
            {t.rich("style_premium_hint", {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
        )}
      </StepSection>

      {/* ─── Step 4 : Customizations + overlays ──────────────────────── */}
      <StepSection number={4} title={t("step_customization")}>
        <CustomizationPanel
          isPro={isPro}
          isStudio={isStudio}
          customizations={customizations}
          onCustomizationsChange={setCustomizations}
          t={t}
        />
        <div className="space-y-1 pt-2">
          <h3 className="text-foreground text-sm font-semibold">
            {t("overlays.section_title")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("overlays.section_subtitle")}
          </p>
        </div>
        <OverlaysPanel
          titleCard={titleCard}
          lowerThird={lowerThird}
          statCallout={statCallout}
          ctaOutro={ctaOutro}
          onTitleCardChange={setTitleCard}
          onLowerThirdChange={setLowerThird}
          onStatCalloutChange={setStatCallout}
          onCtaOutroChange={handleCtaOutroChange}
          clipDurationSec={clipDurationSec}
          t={t}
        />
      </StepSection>

      {/* ─── Quota + submit ──────────────────────────────────────────── */}
      <section className="border-border bg-card space-y-4 rounded-xl border p-5">
        <h2 className="text-foreground text-base font-semibold">
          {t("step_quota")}
        </h2>
        <QuotaIndicator
          plan={plan}
          secondsUsed={secondsUsed}
          secondsLimit={secondsLimit}
          resetAt={resetAt}
        />
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !!segmentError || !sourceReady}
          className="w-full"
          size="lg"
          aria-busy={submitting}
        >
          {submitting ? t("submitting_label") : t("submit_label")}
        </Button>
        {quotaRemaining !== null && (
          <p className="text-destructive text-xs" role="alert">
            {t("quota_exceeded", { remaining: quotaRemaining })}
          </p>
        )}
        {submitting && (
          <p
            className="text-muted-foreground text-xs"
            role="status"
            aria-live="polite"
          >
            {waitingStatus
              ? t(`gallery_status_${waitingStatus}`)
              : t("submit_waiting")}
          </p>
        )}
      </section>

      {/* ─── Recent clips (embedded strip) ───────────────────────────── */}
      {recentClips.length > 0 && (
        <section className="space-y-3 pt-4">
          <h2 className="text-foreground text-lg font-semibold">
            {t("gallery_section_title")}
          </h2>
          <ClipsGallery clips={recentClips} hideToolbar />
        </section>
      )}
    </div>
  );
}

// ---- sub-components --------------------------------------------------------

type TFn = ReturnType<typeof useTranslations<"clips">>;

function StepSection({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card space-y-4 rounded-xl border p-5">
      <div className="flex items-center gap-2">
        {/* Decorative step number — the heading carries the semantics. */}
        <span
          className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
          aria-hidden="true"
        >
          {number}
        </span>
        <h2 className="text-foreground text-base font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

// ---- customization panel ----------------------------------------------------

interface CustomizationPanelProps {
  isPro: boolean;
  isStudio: boolean;
  customizations: SubtitleCustomizations;
  onCustomizationsChange: (c: SubtitleCustomizations) => void;
  t: TFn;
}

function CustomizationPanel({
  isPro,
  isStudio,
  customizations,
  onCustomizationsChange,
  t,
}: CustomizationPanelProps) {
  if (!isPro) {
    return (
      <p className="text-muted-foreground text-sm">
        {t.rich("custom_unavailable", {
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
    );
  }

  const patchCustom = (patch: Partial<SubtitleCustomizations>) =>
    onCustomizationsChange({ ...customizations, ...patch });

  return (
    <div className="space-y-4">
      {/* Pro+ : colour pickers (palette for pro, free hex for studio) */}
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium">
          {t("custom_text_color")}
        </p>
        <ColorPicker
          mode={isStudio ? "free" : "palette"}
          value={customizations.text_color ?? "#FFFFFF"}
          onChange={(hex) => patchCustom({ text_color: hex })}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium">
          {t("custom_highlight_color")}
        </p>
        <ColorPicker
          mode={isStudio ? "free" : "palette"}
          value={customizations.highlight_color ?? "#FFD700"}
          onChange={(hex) => patchCustom({ highlight_color: hex })}
        />
      </div>

      {/* Studio : font picker (curated list — server strips off-list) */}
      {isStudio && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground text-xs font-medium">
            {t("custom_font")}
          </p>
          <FontPicker
            value={customizations.font ?? "Inter Bold"}
            onChange={(font) => patchCustom({ font })}
          />
        </div>
      )}

      {/* Studio : subtitle vertical position (4 presets). Pro sees a
          locked hint nudging upgrade — server strips it anyway. */}
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium">
          {t("custom_position_label")}
        </p>
        {isStudio ? (
          <div className="space-y-1">
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t("custom_position_aria")}
            >
              {(["top", "middle", "lower_third", "bottom"] as const).map(
                (p) => {
                  // Default = lower_third (clears TikTok / Shorts /
                  // Reels UI overlays — safe-zone audit carried over).
                  const active =
                    (customizations.position ?? "lower_third") === p;
                  const isRecommended = p === "lower_third";
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => patchCustom({ position: p })}
                      className={cn(
                        "min-w-[80px] flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:border-primary/50",
                      )}
                    >
                      <span>{t(`custom_position_${p}`)}</span>
                      {isRecommended && (
                        <span className="ml-1 text-[9px] tracking-wide text-emerald-600 uppercase">
                          {t("custom_position_recommended")}
                        </span>
                      )}
                    </button>
                  );
                },
              )}
            </div>
            {customizations.position === "bottom" && (
              <p className="text-[10px] text-amber-600">
                {t("custom_position_bottom_warning")}
              </p>
            )}
          </div>
        ) : (
          <div
            className="border-border bg-muted/30 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            aria-disabled="true"
            data-state="locked"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("custom_position_studio_gate")}</span>
          </div>
        )}
      </div>

      {/* Studio : per-word emphasis color cycle (max 5). */}
      {isStudio && (
        <div className="space-y-1.5">
          <p className="text-muted-foreground text-xs font-medium">
            {t("custom_emphasis_cycle_label")}
          </p>
          <div className="flex gap-2">
            {Array.from({ length: 5 }, (_, i) => {
              const colors = customizations.emphasis_colors ?? [];
              const value = colors[i] ?? "";
              return (
                <input
                  key={i}
                  type="color"
                  value={value || "#FFFFFF"}
                  onChange={(e) => {
                    const next = [...colors];
                    next[i] = e.target.value.toUpperCase();
                    // Drop falsy slots from the END so the cycle stays compact
                    while (next.length > 0 && !next[next.length - 1]) {
                      next.pop();
                    }
                    patchCustom({
                      emphasis_colors: next.length > 0 ? next : undefined,
                    });
                  }}
                  className={cn(
                    "h-8 w-8 cursor-pointer rounded border",
                    value ? "border-primary" : "border-border opacity-40",
                  )}
                  aria-label={t("custom_emphasis_cycle_slot", { slot: i + 1 })}
                />
              );
            })}
          </div>
          <p className="text-muted-foreground text-[10px]">
            {t("custom_emphasis_cycle_hint")}
          </p>
          {(customizations.emphasis_colors?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => patchCustom({ emphasis_colors: undefined })}
              className="text-muted-foreground hover:text-foreground text-[10px] underline focus:outline-none"
            >
              {t("custom_emphasis_cycle_reset")}
            </button>
          )}
        </div>
      )}

      {/* Studio : animation speed slider 0.5-2.0× */}
      {isStudio && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs font-medium">
              {t("custom_animation_speed_label")}
            </p>
            <span className="text-muted-foreground font-mono text-xs">
              {(customizations.animation_speed ?? 1).toFixed(1)}×
            </span>
          </div>
          <input
            type="range"
            min={0.5}
            max={2.0}
            step={0.1}
            value={customizations.animation_speed ?? 1}
            onChange={(e) =>
              patchCustom({ animation_speed: Number(e.target.value) })
            }
            className="accent-primary w-full"
            aria-label={t("custom_animation_speed_label")}
          />
          {typeof customizations.animation_speed === "number" &&
            customizations.animation_speed !== 1 && (
              <button
                type="button"
                onClick={() => patchCustom({ animation_speed: undefined })}
                className="text-muted-foreground hover:text-foreground text-[10px] underline focus:outline-none"
              >
                {t("custom_animation_speed_reset")}
              </button>
            )}
        </div>
      )}

      {/* Studio : auto-emphasis toggle */}
      {isStudio && (
        <div className="space-y-1.5">
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={customizations.auto_emphasis === true}
              onChange={(e) =>
                patchCustom({ auto_emphasis: e.target.checked || undefined })
              }
              className="accent-primary"
            />
            <span>{t("custom_auto_emphasis_label")}</span>
          </label>
          <p className="text-muted-foreground pl-6 text-[10px]">
            {t("custom_auto_emphasis_hint")}
          </p>
        </div>
      )}

      {/* Studio : background opacity slider 0-100 % (Comic Bubble + Bar) */}
      {isStudio && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs font-medium">
              {t("custom_bg_opacity_label")}
            </p>
            <span className="text-muted-foreground font-mono text-xs">
              {customizations.background_opacity ?? "auto"}
              {typeof customizations.background_opacity === "number" ? "%" : ""}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={customizations.background_opacity ?? 50}
            onChange={(e) =>
              patchCustom({ background_opacity: Number(e.target.value) })
            }
            className="accent-primary w-full"
            aria-label={t("custom_bg_opacity_label")}
          />
          {typeof customizations.background_opacity === "number" && (
            <button
              type="button"
              onClick={() => patchCustom({ background_opacity: undefined })}
              className="text-muted-foreground hover:text-foreground text-[10px] underline focus:outline-none"
            >
              {t("custom_bg_opacity_reset")}
            </button>
          )}
        </div>
      )}

      {/* Studio : stroke width slider 0-12 px */}
      {isStudio && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs font-medium">
              {t("custom_stroke_width_label")}
            </p>
            <span className="text-muted-foreground font-mono text-xs">
              {customizations.stroke_width ?? "auto"}
              {typeof customizations.stroke_width === "number" ? "px" : ""}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={12}
            step={1}
            value={customizations.stroke_width ?? 4}
            onChange={(e) =>
              patchCustom({ stroke_width: Number(e.target.value) })
            }
            className="accent-primary w-full"
            aria-label={t("custom_stroke_width_label")}
          />
          {typeof customizations.stroke_width === "number" && (
            <button
              type="button"
              onClick={() => patchCustom({ stroke_width: undefined })}
              className="text-muted-foreground hover:text-foreground text-[10px] underline focus:outline-none"
            >
              {t("custom_stroke_width_reset")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- overlays panel ----------------------------------------------------------

interface OverlaysPanelProps {
  titleCard: TitleCardFormState;
  lowerThird: LowerThirdFormState;
  statCallout: StatCalloutFormState;
  ctaOutro: CtaOutroFormState;
  onTitleCardChange: (s: TitleCardFormState) => void;
  onLowerThirdChange: (s: LowerThirdFormState) => void;
  onStatCalloutChange: (s: StatCalloutFormState) => void;
  onCtaOutroChange: (s: CtaOutroFormState) => void;
  /** Clip duration in seconds — clamps start/end inputs so the user can't
   *  request an overlay window past the clip end. */
  clipDurationSec: number;
  t: TFn;
}

/** Small labelled numeric input shared by the 4 overlay sub-blocks. */
function OverlaySecondsInput({
  id,
  label,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        max={max}
        step={0.1}
        value={value}
        onChange={(e) => onChange(clampSec(Number(e.target.value), max))}
        className="w-24 font-mono text-sm"
      />
    </div>
  );
}

function OverlaysPanel({
  titleCard,
  lowerThird,
  statCallout,
  ctaOutro,
  onTitleCardChange,
  onLowerThirdChange,
  onStatCalloutChange,
  onCtaOutroChange,
  clipDurationSec,
  t,
}: OverlaysPanelProps) {
  // Enabled-but-empty required text → soft warning (the submit handler
  // silently drops the overlay otherwise).
  const titleCardError =
    titleCard.enabled && titleCard.text.trim().length === 0;
  const lowerThirdError =
    lowerThird.enabled && lowerThird.name.trim().length === 0;
  const statCalloutError =
    statCallout.enabled && statCallout.value.trim().length === 0;
  const ctaOutroError = ctaOutro.enabled && ctaOutro.text.trim().length === 0;

  return (
    <div className="space-y-4">
      {/* Title card */}
      <div className="border-border bg-background/50 space-y-3 rounded-lg border p-4">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={titleCard.enabled}
            onChange={(e) =>
              onTitleCardChange({ ...titleCard, enabled: e.target.checked })
            }
            className="border-border accent-primary h-4 w-4 rounded"
          />
          <span className="text-foreground text-sm font-medium">
            {t("overlays.title_card.toggle")}
          </span>
        </label>
        {titleCard.enabled && (
          <div className="space-y-3 pl-6">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="overlay-tc-text"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("overlays.title_card.text_label")}
              </label>
              <Input
                id="overlay-tc-text"
                value={titleCard.text}
                onChange={(e) =>
                  onTitleCardChange({ ...titleCard, text: e.target.value })
                }
                placeholder={t("overlays.title_card.text_placeholder")}
                maxLength={TITLE_CARD_TEXT_MAX}
                aria-invalid={titleCardError}
                className="w-full"
              />
              {titleCardError && (
                <p className="text-destructive text-[11px]">
                  {t("overlays.title_card.required_hint")}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="overlay-tc-subtitle"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("overlays.title_card.subtitle_label")}
              </label>
              <Input
                id="overlay-tc-subtitle"
                value={titleCard.subtitle}
                onChange={(e) =>
                  onTitleCardChange({ ...titleCard, subtitle: e.target.value })
                }
                placeholder={t("overlays.title_card.subtitle_placeholder")}
                maxLength={TITLE_CARD_SUBTITLE_MAX}
                className="w-full"
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <OverlaySecondsInput
                id="overlay-tc-start"
                label={t("overlays.title_card.start_label")}
                value={titleCard.startSec}
                max={clipDurationSec}
                onChange={(v) =>
                  onTitleCardChange({ ...titleCard, startSec: v })
                }
              />
              <OverlaySecondsInput
                id="overlay-tc-end"
                label={t("overlays.title_card.end_label")}
                value={titleCard.endSec}
                max={clipDurationSec}
                onChange={(v) => onTitleCardChange({ ...titleCard, endSec: v })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Lower third */}
      <div className="border-border bg-background/50 space-y-3 rounded-lg border p-4">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={lowerThird.enabled}
            onChange={(e) =>
              onLowerThirdChange({ ...lowerThird, enabled: e.target.checked })
            }
            className="border-border accent-primary h-4 w-4 rounded"
          />
          <span className="text-foreground text-sm font-medium">
            {t("overlays.lower_third.toggle")}
          </span>
        </label>
        {lowerThird.enabled && (
          <div className="space-y-3 pl-6">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="overlay-lt-name"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("overlays.lower_third.name_label")}
              </label>
              <Input
                id="overlay-lt-name"
                value={lowerThird.name}
                onChange={(e) =>
                  onLowerThirdChange({ ...lowerThird, name: e.target.value })
                }
                placeholder={t("overlays.lower_third.name_placeholder")}
                maxLength={LOWER_THIRD_NAME_MAX}
                aria-invalid={lowerThirdError}
                className="w-full"
              />
              {lowerThirdError && (
                <p className="text-destructive text-[11px]">
                  {t("overlays.lower_third.required_hint")}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="overlay-lt-role"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("overlays.lower_third.role_label")}
              </label>
              <Input
                id="overlay-lt-role"
                value={lowerThird.role}
                onChange={(e) =>
                  onLowerThirdChange({ ...lowerThird, role: e.target.value })
                }
                placeholder={t("overlays.lower_third.role_placeholder")}
                maxLength={LOWER_THIRD_ROLE_MAX}
                className="w-full"
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <OverlaySecondsInput
                id="overlay-lt-start"
                label={t("overlays.lower_third.start_label")}
                value={lowerThird.startSec}
                max={clipDurationSec}
                onChange={(v) =>
                  onLowerThirdChange({ ...lowerThird, startSec: v })
                }
              />
              <OverlaySecondsInput
                id="overlay-lt-end"
                label={t("overlays.lower_third.end_label")}
                value={lowerThird.endSec}
                max={clipDurationSec}
                onChange={(v) =>
                  onLowerThirdChange({ ...lowerThird, endSec: v })
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* Stat callout */}
      <div className="border-border bg-background/50 space-y-3 rounded-lg border p-4">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={statCallout.enabled}
            onChange={(e) =>
              onStatCalloutChange({ ...statCallout, enabled: e.target.checked })
            }
            className="border-border accent-primary h-4 w-4 rounded"
          />
          <span className="text-foreground text-sm font-medium">
            {t("overlays.stat_callout.toggle")}
          </span>
        </label>
        {statCallout.enabled && (
          <div className="space-y-3 pl-6">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="overlay-sc-value"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("overlays.stat_callout.value_label")}
              </label>
              <Input
                id="overlay-sc-value"
                value={statCallout.value}
                onChange={(e) =>
                  onStatCalloutChange({ ...statCallout, value: e.target.value })
                }
                placeholder={t("overlays.stat_callout.value_placeholder")}
                maxLength={STAT_CALLOUT_VALUE_MAX}
                aria-invalid={statCalloutError}
                className="w-full"
              />
              {statCalloutError && (
                <p className="text-destructive text-[11px]">
                  {t("overlays.stat_callout.required_hint")}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="overlay-sc-label"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("overlays.stat_callout.label_label")}
              </label>
              <Input
                id="overlay-sc-label"
                value={statCallout.label}
                onChange={(e) =>
                  onStatCalloutChange({ ...statCallout, label: e.target.value })
                }
                placeholder={t("overlays.stat_callout.label_placeholder")}
                maxLength={STAT_CALLOUT_LABEL_MAX}
                className="w-full"
              />
            </div>
            <PositionPicker
              value={statCallout.position}
              onChange={(p) =>
                onStatCalloutChange({ ...statCallout, position: p })
              }
              allowCenter={true}
              label={t("overlays.stat_callout.position_label")}
              dotLabel="📊"
            />
            <div className="flex flex-wrap gap-3">
              <OverlaySecondsInput
                id="overlay-sc-start"
                label={t("overlays.stat_callout.start_label")}
                value={statCallout.startSec}
                max={clipDurationSec}
                onChange={(v) =>
                  onStatCalloutChange({ ...statCallout, startSec: v })
                }
              />
              <OverlaySecondsInput
                id="overlay-sc-end"
                label={t("overlays.stat_callout.end_label")}
                value={statCallout.endSec}
                max={clipDurationSec}
                onChange={(v) =>
                  onStatCalloutChange({ ...statCallout, endSec: v })
                }
              />
            </div>
          </div>
        )}
      </div>

      {/* CTA outro */}
      <div className="border-border bg-background/50 space-y-3 rounded-lg border p-4">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={ctaOutro.enabled}
            onChange={(e) =>
              onCtaOutroChange({ ...ctaOutro, enabled: e.target.checked })
            }
            className="border-border accent-primary h-4 w-4 rounded"
          />
          <span className="text-foreground text-sm font-medium">
            {t("overlays.cta_outro.toggle")}
          </span>
        </label>
        {ctaOutro.enabled && (
          <div className="space-y-3 pl-6">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="overlay-cta-text"
                className="text-muted-foreground text-xs font-medium"
              >
                {t("overlays.cta_outro.text_label")}
              </label>
              <Input
                id="overlay-cta-text"
                value={ctaOutro.text}
                onChange={(e) =>
                  onCtaOutroChange({ ...ctaOutro, text: e.target.value })
                }
                placeholder={t("overlays.cta_outro.text_placeholder")}
                maxLength={CTA_OUTRO_TEXT_MAX}
                aria-invalid={ctaOutroError}
                className="w-full"
              />
              {ctaOutroError && (
                <p className="text-destructive text-[11px]">
                  {t("overlays.cta_outro.required_hint")}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              <OverlaySecondsInput
                id="overlay-cta-start"
                label={t("overlays.cta_outro.start_label")}
                value={ctaOutro.startSec}
                max={clipDurationSec}
                onChange={(v) => onCtaOutroChange({ ...ctaOutro, startSec: v })}
              />
              <OverlaySecondsInput
                id="overlay-cta-end"
                label={t("overlays.cta_outro.end_label")}
                value={ctaOutro.endSec}
                max={clipDurationSec}
                onChange={(v) => onCtaOutroChange({ ...ctaOutro, endSec: v })}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
