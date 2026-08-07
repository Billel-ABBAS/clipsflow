// ============================================================================
// /clips — hub page (gallery of the user's 50 most recent clips).
// Ported from VidiaFlow src/app/[locale]/(dashboard)/clips/page.tsx,
// SIMPLIFIED for ClipsFlow P1 : no BrandKitTeaser, no "Bibliothèque" tab.
// Renders QuotaIndicator + OnboardingHero (only when 0 clips) +
// WatermarkNotice (free plan only — never mounts in P1 where resolvePlan()
// returns 'pro') + ClipsGallery + "New clip" CTA.
// ============================================================================

import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import {
  CLIP_SELECT_COLUMNS,
  toGalleryRow,
  type ClipRowRaw,
} from "@/components/clips/clip-rows";
import {
  ClipsGallery,
  type GalleryClipRow,
} from "@/components/clips/ClipsGallery";
import { OnboardingHero } from "@/components/clips/OnboardingHero";
import { QuotaIndicator } from "@/components/clips/QuotaIndicator";
import { WatermarkNotice } from "@/components/clips/WatermarkNotice";
import { buttonVariants } from "@/components/ui/button";
import { Link, redirect } from "@/i18n/navigation";
import { QUOTAS_SECONDS, resolvePlan } from "@/lib/clips/quota";
import { refreshClipUrls } from "@/lib/clips/refresh-urls";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

// Force per-request render — without this Next.js may serve a stale empty
// gallery RSC payload right after a clip completed (the user lands here
// from router.push immediately after the realtime 'completed' signal, so
// the SSR query MUST hit the DB freshly each navigation).
export const dynamic = "force-dynamic";

export default async function ClipsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("clips");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: "/login", locale });
    return null;
  }

  // 50 most recent clips + episode title join. Storage paths selected
  // alongside the persisted signed URLs so refreshClipUrls() can re-sign
  // on every render (the persisted URLs carry a 24 h TTL).
  const { data: rows } = await supabase
    .from("clips")
    .select(CLIP_SELECT_COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const refreshed = await refreshClipUrls(
    supabase,
    (rows ?? []) as unknown as ClipRowRaw[],
  );
  const clips: GalleryClipRow[] = refreshed.map(toGalleryRow);

  // Quota header — P1 : resolvePlan() returns 'pro' for everyone.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, clip_seconds_used_this_month, clip_quota_reset_at")
    .eq("id", user.id)
    .maybeSingle();

  const plan = resolvePlan(profile);
  const secondsUsed =
    (profile?.clip_seconds_used_this_month as number | null) ?? 0;
  const secondsLimit = QUOTAS_SECONDS[plan] ?? 0;
  const resetAt = (profile?.clip_quota_reset_at as string | null) ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">
            {t("page_title")}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {t("page_subtitle")}
          </p>
        </div>
        <div className="flex min-w-[220px] flex-col items-end gap-3">
          <Link
            href="/clips/new"
            className={cn(buttonVariants())}
            data-testid="clips-new-cta"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("new_clip_cta")}
          </Link>
          <div className="w-[220px]">
            <QuotaIndicator
              plan={plan}
              secondsUsed={secondsUsed}
              secondsLimit={secondsLimit}
              resetAt={resetAt}
            />
          </div>
        </div>
      </div>

      {/* Free-plan watermark disclosure (returns null for paid plans). */}
      <WatermarkNotice plan={plan} />

      {/* First-run onboarding — only when the gallery is empty. The client
          component additionally reads the localStorage dismiss flag. */}
      {clips.length === 0 && <OnboardingHero />}

      <ClipsGallery clips={clips} />
    </div>
  );
}
