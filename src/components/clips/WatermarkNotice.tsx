// ============================================================================
// WatermarkNotice — Free-tier watermark disclosure banner.
// Ported from VidiaFlow src/components/clipflow/WatermarkNotice.tsx.
// Adaptations : i18n namespace dashboard.clipflow.watermark_notice →
// clips.watermark_notice ; copy mentions ClipsFlow.
//
// Server component — read-only, no interactivity. Rendered only for the
// `free` plan ; everyone else gets `null`. NOTE P1 : resolvePlan() returns
// 'pro' for every user, so this banner never mounts — ported anyway so the
// P3 billing phase only has to flip the plan resolution.
// ============================================================================

import { Info } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

interface WatermarkNoticeProps {
  plan: string;
}

export async function WatermarkNotice({ plan }: WatermarkNoticeProps) {
  if (plan !== "free") return null;
  const t = await getTranslations("clips.watermark_notice");
  return (
    <div
      data-testid="clips-watermark-notice"
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm"
    >
      <Info className="h-4 w-4 flex-none text-amber-500" aria-hidden="true" />
      <p className="text-foreground/90 flex-1">{t("free_banner")}</p>
      <Link href="/pricing" className="text-xs font-medium underline">
        {t("upgrade_cta")}
      </Link>
    </div>
  );
}
