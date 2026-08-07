"use client";

// ============================================================================
// RetryClipButton — re-enqueue a failed clip.
// Ported from VidiaFlow src/components/clipflow/RetryClipButton.tsx.
// Adaptation P1 (no dedicated retry API in ClipsFlow) : instead of calling
// POST /api/clipflow/jobs/[id]/retry, the button re-POSTs
// /api/clips/jobs with the SAME parameters as the failed clip (episode_id,
// segment, style, aspect, language, customizations, overlays). A fresh
// `clips` row is created ; the failed row stays in the gallery as the
// audit trail. Quota is re-reserved — a 402 surfaces a dedicated message.
// ============================================================================

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { OverlayElement } from "@/lib/clips/overlays";
import type { SubtitleCustomizations } from "@/lib/clips/types";

/** Everything needed to re-submit the failed clip as a fresh job. */
export interface RetryClipSeed {
  episode_id: string;
  start_seconds: number;
  end_seconds: number;
  style_key: string;
  aspect_ratio: string;
  language: string;
  customizations: SubtitleCustomizations | null;
  overlays: OverlayElement[] | null;
}

interface RetryClipButtonProps {
  seed: RetryClipSeed;
}

export function RetryClipButton({ seed }: RetryClipButtonProps) {
  const t = useTranslations("clips.retry");
  const router = useRouter();
  const [running, setRunning] = useState(false);

  const handleClick = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/clips/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episode_id: seed.episode_id,
          start_seconds: seed.start_seconds,
          end_seconds: seed.end_seconds,
          style_key: seed.style_key,
          aspect_ratio: seed.aspect_ratio,
          language: seed.language,
          customizations: seed.customizations ?? {},
          overlays: seed.overlays ?? [],
        }),
      });
      if (res.status === 402) {
        toast.error(t("quota_exceeded"));
        return;
      }
      if (res.status !== 202) throw new Error(`retry_failed_${res.status}`);
      toast.success(t("success"));
      router.refresh();
    } catch {
      toast.error(t("error"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleClick}
      disabled={running}
      data-testid="clips-retry-button"
      className="gap-1.5"
    >
      <RefreshCw className={running ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      {running ? t("running") : t("label")}
    </Button>
  );
}
