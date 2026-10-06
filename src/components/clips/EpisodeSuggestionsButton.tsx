"use client";

import { useState } from "react";
import { Lightbulb } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

interface Suggestion {
  start_seconds: number;
  end_seconds: number;
  text: string;
  score: number;
  estimated_cost_usd: number;
}

export function EpisodeSuggestionsButton({ episodeId }: { episodeId: string }) {
  const t = useTranslations("clips.suggestions");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const loadSuggestions = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (suggestions.length > 0) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/clips/episodes/${episodeId}/suggestions`,
        { cache: "no-store" },
      );
      const result = (await response.json()) as {
        data?: Suggestion[];
      };
      if (!response.ok || !result.data) {
        throw new Error("suggestions_unavailable");
      }
      setSuggestions(result.data);
    } catch {
      toast.error(t("error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void loadSuggestions()}
        aria-expanded={open}
        className="gap-1.5"
      >
        <Lightbulb className="h-3.5 w-3.5" />
        {loading ? t("loading") : t("button")}
      </Button>
      {open && !loading ? (
        <div className="border-border bg-muted/20 mt-3 space-y-2 rounded-lg border p-3">
          <h3 className="text-sm font-medium">{t("title")}</h3>
          {suggestions.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("empty")}</p>
          ) : (
            <ul className="space-y-2">
              {suggestions.map((suggestion) => {
                const query = new URLSearchParams({
                  episode: episodeId,
                  start: String(suggestion.start_seconds),
                  end: String(suggestion.end_seconds),
                });
                return (
                  <li
                    key={`${suggestion.start_seconds}-${suggestion.end_seconds}`}
                    className="bg-background rounded-md p-2.5"
                  >
                    <p className="text-sm">{suggestion.text}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {suggestion.start_seconds}s–{suggestion.end_seconds}s ·{" "}
                      {t("estimate", {
                        amount: suggestion.estimated_cost_usd.toFixed(4),
                      })}
                    </p>
                    <Link
                      href={`/clips/new?${query.toString()}`}
                      className="text-primary mt-2 inline-block text-xs font-medium underline underline-offset-4"
                    >
                      {t("select")}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
