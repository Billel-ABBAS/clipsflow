// ============================================================================
// /clips/new — clip creation page (server wrapper around <ClipStudio />).
// Ported from VidiaFlow src/app/[locale]/(dashboard)/clips/new/page.tsx.
// Fetches : 3 most recent clips (embedded strip), the user's 30 most
// recent episodes (Step 1 "existing episode" tab), the quota profile, and
// the optional `?dup=<clipId>` seed (original clips row → pre-filled form,
// with `?aspect=` override from the ReclipMenu).
// ============================================================================

import { setRequestLocale } from "next-intl/server";

import {
  CLIP_SELECT_COLUMNS,
  toGalleryRow,
  type ClipRowRaw,
} from "@/components/clips/clip-rows";
import {
  ClipStudio,
  type DuplicateSeed,
  type EpisodeOption,
} from "@/components/clips/ClipStudio";
import type { GalleryClipRow } from "@/components/clips/ClipsGallery";
import { redirect } from "@/i18n/navigation";
import { QUOTAS_SECONDS, resolvePlan } from "@/lib/clips/quota";
import { refreshClipUrls } from "@/lib/clips/refresh-urls";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function NewClipPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ dup?: string; aspect?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { dup, aspect } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: "/login", locale });
    return null;
  }

  // Quota props — P1 : resolvePlan() returns 'pro' for everyone.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, clip_seconds_used_this_month, clip_quota_reset_at, plan")
    .eq("id", user.id)
    .maybeSingle();
  const plan = resolvePlan(profile);
  const secondsUsed =
    (profile?.clip_seconds_used_this_month as number | null) ?? 0;
  const secondsLimit = QUOTAS_SECONDS[plan] ?? 0;
  const resetAt = (profile?.clip_quota_reset_at as string | null) ?? null;

  // Existing episodes for the Step 1 "episode" tab (30 most recent).
  const { data: episodeRows } = await supabase
    .from("episodes")
    .select("id, title, source_type, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(30);
  const episodes: EpisodeOption[] = (episodeRows ?? []).map((e) => ({
    id: e.id as string,
    title: (e.title as string | null) ?? "—",
    source_type: (e.source_type as string | null) ?? "upload",
    created_at: e.created_at as string,
  }));

  // `?dup=<clipId>` — server-resolved seed from the original clips row.
  // `?aspect=` (ReclipMenu "duplicate as 1:1 / 9:16") overrides the
  // original aspect ratio.
  let dupSeed: DuplicateSeed | null = null;
  if (dup) {
    const { data: orig } = await supabase
      .from("clips")
      .select(
        "episode_id, start_seconds, end_seconds, aspect_ratio, style_key, language",
      )
      .eq("id", dup)
      .eq("user_id", user.id)
      .maybeSingle();
    if (orig) {
      dupSeed = {
        episodeId: orig.episode_id as string,
        startSeconds: (orig.start_seconds as number | null) ?? 0,
        endSeconds: (orig.end_seconds as number | null) ?? 30,
        aspectRatio: aspect ?? (orig.aspect_ratio as string | null) ?? null,
        styleKey: (orig.style_key as string | null) ?? null,
        language: (orig.language as string | null) ?? null,
      };
    }
  }

  // Embedded "recent clips" strip — capped at 3 rows (full gallery lives
  // on /clips). Signed URLs re-signed before render (24 h TTL).
  const { data: rows } = await supabase
    .from("clips")
    .select(CLIP_SELECT_COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(3);
  const refreshed = await refreshClipUrls(
    supabase,
    (rows ?? []) as unknown as ClipRowRaw[],
  );
  const recentClips: GalleryClipRow[] = refreshed.map(toGalleryRow);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <ClipStudio
        episodes={episodes}
        recentClips={recentClips}
        plan={plan}
        secondsUsed={secondsUsed}
        secondsLimit={secondsLimit}
        resetAt={resetAt}
        initialDuplicateSeed={dupSeed}
      />
    </div>
  );
}
