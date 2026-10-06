"use client";

// ============================================================================
// Retry a failed clip through an idempotent server operation. Concurrent
// clicks reuse one active retry, while a later retry after another failure
// becomes a new explicitly charged attempt.
// ============================================================================

import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
interface RetryClipButtonProps {
  clipId: string;
}

export function RetryClipButton({ clipId }: RetryClipButtonProps) {
  const t = useTranslations("clips.retry");
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const requestIdRef = useRef<string | null>(null);

  const handleClick = async () => {
    setRunning(true);
    try {
      const requestId = requestIdRef.current ?? crypto.randomUUID();
      requestIdRef.current = requestId;
      const res = await fetch("/api/clips/jobs/retry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({ clip_id: clipId }),
      });
      const result = (await res.json().catch(() => null)) as {
        error?: string;
        data?: { status?: string };
      } | null;
      if (res.status === 402) {
        toast.error(t("quota_exceeded"));
        return;
      }
      if (
        res.status === 503 &&
        result?.error === "rendering_temporarily_unavailable"
      ) {
        toast.error(t("worker_unavailable"));
        return;
      }
      if (res.status !== 202 && res.status !== 200) {
        throw new Error(`retry_failed_${res.status}`);
      }
      requestIdRef.current = null;
      if (result?.data?.status === "failed") {
        toast.error(t("error"));
      } else {
        toast.success(t("success"));
      }
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
