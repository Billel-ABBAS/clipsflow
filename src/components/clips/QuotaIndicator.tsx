"use client";

import { useLocale, useTranslations } from "next-intl";

import { QUOTAS_SECONDS, type Plan } from "@/lib/clips/quota";
import { cn } from "@/lib/utils";

// ============================================================================
// QuotaIndicator — monthly clip-seconds usage bar + reset date.
// Ported from VidiaFlow src/components/clipflow/QuotaIndicator.tsx.
// Adaptations : PlanCode → Plan + QUOTAS_SECONDS from @/lib/clips/quota ;
// i18n namespace dashboard.clipflow → clips.
// ============================================================================

export interface QuotaIndicatorProps {
  plan: Plan;
  secondsUsed: number;
  secondsLimit: number;
  resetAt: string | null;
}

function formatMinutes(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins} min ${secs} s` : `${mins} min`;
}

export function QuotaIndicator({
  plan,
  secondsUsed,
  secondsLimit,
  resetAt,
}: QuotaIndicatorProps) {
  const t = useTranslations("clips");
  const locale = useLocale();

  const limit = secondsLimit > 0 ? secondsLimit : (QUOTAS_SECONDS[plan] ?? 0);
  const used = Math.min(secondsUsed, limit);
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

  const barColor =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-400" : "bg-emerald-400";

  const resetDateStr = (() => {
    if (!resetAt) return "—";
    try {
      return new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "long",
      }).format(new Date(resetAt));
    } catch {
      return resetAt;
    }
  })();

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>
          {t("quota_used_of", {
            used: formatMinutes(used),
            limit: formatMinutes(limit),
          })}
        </span>
        <span
          className={cn(
            "font-mono font-semibold",
            pct >= 90
              ? "text-red-500"
              : pct >= 70
                ? "text-yellow-500"
                : "text-emerald-500",
          )}
        >
          {pct} %
        </span>
      </div>

      {/* Progress bar */}
      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      {resetAt && (
        <p className="text-muted-foreground text-xs">
          {t("quota_reset", { date: resetDateStr })}
        </p>
      )}
    </div>
  );
}
