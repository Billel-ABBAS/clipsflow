"use client";

import { useState } from "react";
import { Check, Copy, Share2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ShareRecord {
  id: string;
  created_at: string;
  revoked_at: string | null;
}

interface ShareButtonProps {
  clipId: string;
  title?: string;
  className?: string;
}

export function ShareButton({ clipId, title, className }: ShareButtonProps) {
  const t = useTranslations("clips.share");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shares, setShares] = useState<ShareRecord[]>([]);
  const [latestUrl, setLatestUrl] = useState<string | null>(null);

  const loadShares = async () => {
    try {
      const response = await fetch(`/api/clips/${clipId}/shares`, {
        cache: "no-store",
      });
      const result = (await response.json()) as { data?: ShareRecord[] };
      if (!response.ok || !result.data) throw new Error("shares_unavailable");
      setShares(result.data);
    } catch {
      toast.error(t("load_error"));
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copy_error"));
    }
  };

  const createLink = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/clips/${clipId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: locale === "fr" ? "fr" : "en" }),
      });
      const result = (await response.json()) as {
        data?: { id: string; created_at: string; url: string };
      };
      if (!response.ok || !result.data) throw new Error("share_create_failed");
      setLatestUrl(result.data.url);
      setShares((current) => [
        { ...result.data!, revoked_at: null },
        ...current,
      ]);
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share({ url: result.data.url, title });
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            await copy(result.data.url);
          }
        }
      } else {
        await copy(result.data.url);
      }
    } catch {
      toast.error(t("create_error"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (shareId: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/clips/${clipId}/shares`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_id: shareId }),
      });
      if (!response.ok) throw new Error("share_revoke_failed");
      setShares((current) =>
        current.map((share) =>
          share.id === shareId
            ? { ...share, revoked_at: new Date().toISOString() }
            : share,
        ),
      );
      setLatestUrl(null);
      toast.success(t("revoked"));
    } catch {
      toast.error(t("revoke_error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("relative inline-flex", className)}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) void loadShares();
        }}
        aria-expanded={open}
        data-testid="clips-share-button"
        className="gap-1.5"
      >
        <Share2 className="h-4 w-4" />
        <span className="sr-only sm:not-sr-only">{t("label")}</span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label={t("label")}
          data-testid="clips-share-popover"
          className="border-border bg-card absolute top-full right-0 z-20 mt-1.5 w-72 rounded-md border p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{t("private_link_title")}</p>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("close")}
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("private_link_hint")}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={createLink}
            disabled={busy}
            className="mt-3 w-full"
          >
            {copied ? <Check className="mr-1.5 h-4 w-4" /> : null}
            {busy ? t("creating") : t("create_link")}
          </Button>
          {latestUrl && (
            <div className="mt-2 flex gap-1.5">
              <input
                readOnly
                value={latestUrl}
                aria-label={t("copy_link")}
                className="border-border bg-background text-muted-foreground min-w-0 flex-1 rounded border px-2 py-1 text-xs"
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label={t("copy_link")}
                onClick={() => void copy(latestUrl)}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {shares.some((share) => !share.revoked_at) && (
            <div className="mt-3 space-y-2">
              <p className="text-muted-foreground text-xs font-medium">
                {t("active_links")}
              </p>
              {shares
                .filter((share) => !share.revoked_at)
                .map((share) => (
                  <div
                    key={share.id}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <time
                      dateTime={share.created_at}
                      className="text-muted-foreground"
                    >
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                      }).format(new Date(share.created_at))}
                    </time>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void revoke(share.id)}
                      disabled={busy}
                    >
                      {t("revoke")}
                    </Button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
