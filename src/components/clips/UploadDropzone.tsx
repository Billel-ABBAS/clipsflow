"use client";

// ============================================================================
// UploadDropzone — drag-drop / browse zone for the clip source media.
// Extracted from the inline <UploadZone> of VidiaFlow
// src/components/clipflow/SubtitleStudio.tsx into a standalone component.
// Adaptations : MIME list extended from 3 video types to the 7 types the
// `clip-sources` bucket accepts (audio podcast formats included) ; i18n
// namespace → clips ; selection tokens accent → primary.
//
// Pure presentational : the parent (ClipStudio) owns the upload pipeline
// (upload-init + signed PUT) and passes the reactive `uploadState` down.
// Client-side validation (MIME + 500 MB cap) happens here before onFile.
// ============================================================================

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/** The 7 MIME types accepted by the `clip-sources` bucket (migration
 *  0002_clips_schema.sql `allowed_mime_types`) — keep both lists in sync. */
export const ACCEPTED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
] as const;

export const MAX_UPLOAD_BYTES = 524_288_000; // 500 MB

/** Reactive upload state owned by the parent. */
export type UploadState =
  | { status: "idle" }
  | { status: "uploading"; progress: number; filename: string }
  | { status: "done"; filename: string; episodeId: string }
  | { status: "error"; errorKey: string };

export interface UploadDropzoneProps {
  uploadState: UploadState;
  /** Called with a pre-validated file (MIME + size already checked). */
  onFile: (file: File) => void;
  /** Called when client-side validation fails — receives the i18n error
   *  key relative to the `clips` namespace. */
  onValidationError: (errorKey: string) => void;
  onReset: () => void;
}

export function UploadDropzone({
  uploadState,
  onFile,
  onValidationError,
  onReset,
}: UploadDropzoneProps) {
  const t = useTranslations("clips");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const accept = ACCEPTED_MIME_TYPES.join(",");

  const handleFile = useCallback(
    (file: File) => {
      if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
        onValidationError("upload_error_unsupported_type");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        onValidationError("upload_error_too_large");
        return;
      }
      onFile(file);
    },
    [onFile, onValidationError],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset input so the same file can be re-selected after error/reset.
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [handleFile],
  );

  if (uploadState.status === "done") {
    return (
      <div className="border-border bg-card flex items-center justify-between rounded-lg border px-4 py-3">
        <span className="text-foreground text-sm">
          {t("upload_complete", { filename: uploadState.filename })}
        </span>
        <button
          type="button"
          onClick={onReset}
          className="text-primary text-xs underline hover:no-underline"
        >
          {t("upload_replace")}
        </button>
      </div>
    );
  }

  if (uploadState.status === "uploading") {
    return (
      <div
        className="border-border bg-card space-y-2 rounded-lg border px-4 py-3"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <p className="text-foreground text-sm">
          {t("upload_progress", { percent: uploadState.progress })}
        </p>
        {/* Visual progress bar mirrors the SR-announced text above. */}
        <div
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={uploadState.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("upload_progress", { percent: uploadState.progress })}
        >
          <div
            className="bg-primary h-full rounded-full transition-all"
            style={{ width: `${uploadState.progress}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        aria-label={t("upload_dropzone_label")}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          // Space on a non-button focusable element scrolls the page by
          // default — preventDefault keeps focus on the dropzone + opens
          // the picker without a scroll jump.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={cn(
          "flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors",
          isDragOver
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/60",
        )}
      >
        <p className="text-muted-foreground text-center text-sm">
          {t("upload_dropzone_label")}
        </p>
        {/* Visible button = canonical entry point on touch (HTML5
            drag-drop is not implemented on iOS Safari). 44 px target. */}
        <button
          type="button"
          data-testid="clips-upload-browse-cta"
          onClick={(e) => {
            // Avoid double-firing : the outer div also fires onClick.
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
          className="border-border bg-card text-foreground hover:bg-muted inline-flex min-h-[44px] items-center justify-center rounded-md border px-4 py-2 text-xs font-medium"
        >
          {t("upload_browse_cta")}
        </button>
      </div>
      {uploadState.status === "error" && (
        <p
          className="text-destructive text-xs"
          role="alert"
          aria-live="assertive"
        >
          {t(uploadState.errorKey)}
        </p>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handleFileChange}
        aria-hidden="true"
      />
    </div>
  );
}
