"use client";

// ============================================================================
// ShareButton — Web Share API + desktop fallback.
// Ported from VidiaFlow src/components/clipflow/ShareButton.tsx.
// Adaptations : pure helper import → @/lib/clips/web-share ; i18n namespace
// → clips.share ; default share title mentions ClipsFlow.
//
// Mobile (iOS Safari / Android Chrome) → `navigator.share({ url, title })`
// pops the native sheet. Desktop → clipboard copy + a small dropdown of
// social share URLs (X / LinkedIn / Facebook intents). AbortError (user
// dismissed the sheet) is swallowed silently.
// ============================================================================

import { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { supportsWebShare } from "@/lib/clips/web-share";
import { cn } from "@/lib/utils";

interface ShareButtonProps {
  /** Signed URL to the rendered clip MP4. */
  url: string;
  /** Optional title surfaced in the Web Share sheet / clipboard preview. */
  title?: string;
  className?: string;
}

export function ShareButton({ url, title, className }: ShareButtonProps) {
  const t = useTranslations("clips.share");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  const handleClick = async () => {
    // Try Web Share API first (mobile primarily).
    if (typeof navigator !== "undefined" && supportsWebShare(navigator)) {
      try {
        await navigator.share({
          url,
          title: title ?? "ClipsFlow clip",
        });
        return;
      } catch (err) {
        // User cancelled — not an error path. Silent return.
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Any other failure → fall through to clipboard copy.
      }
    }

    // Desktop fallback : copy + show dropdown of socials.
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      }
    } catch {
      // ignore — share popover still useful even if clipboard failed
    }
    setOpen((p) => !p);
  };

  const encoded = encodeURIComponent(url);
  const text = encodeURIComponent(title ?? "");

  return (
    <div className={cn("relative inline-flex", className)}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={handleClick}
        data-testid="clips-share-button"
        aria-label={t("label")}
        title={t("label")}
        className="gap-1.5"
      >
        {copied ? (
          <Check className="h-4 w-4" />
        ) : (
          <Share2 className="h-4 w-4" />
        )}
        <span className="sr-only sm:not-sr-only">
          {copied ? t("copied") : t("label")}
        </span>
      </Button>
      {open && (
        <div
          role="menu"
          data-testid="clips-share-popover"
          className="border-border bg-card absolute top-full right-0 z-10 mt-1.5 min-w-[180px] rounded-md border p-1 shadow-lg"
        >
          <a
            href={`https://twitter.com/intent/tweet?url=${encoded}&text=${text}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground hover:bg-muted block rounded px-3 py-2 text-xs"
          >
            {t("open_twitter")}
          </a>
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encoded}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground hover:bg-muted block rounded px-3 py-2 text-xs"
          >
            {t("open_linkedin")}
          </a>
          <a
            href={`https://www.facebook.com/sharer/sharer.php?u=${encoded}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground hover:bg-muted block rounded px-3 py-2 text-xs"
          >
            {t("open_facebook")}
          </a>
          <button
            type="button"
            onClick={async () => {
              try {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2_000);
                }
              } catch {
                /* ignore */
              }
              setOpen(false);
            }}
            className="text-foreground hover:bg-muted flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs"
          >
            <Copy className="h-3 w-3" />
            {t("copy_link")}
          </button>
        </div>
      )}
    </div>
  );
}
