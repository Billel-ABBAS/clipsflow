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
import { computeClipCost } from "@/lib/clips/cost";
import { refreshClipUrls } from "@/lib/clips/refresh-urls";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function NewClipPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    dup?: string;
    aspect?: string;
    episode?: string;
    start?: string;
    end?: string;
  }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { dup, aspect, episode, start, end } = await searchParams;

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
    .select("id, title, source_type, created_at, duration_seconds")
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

  // Suggested moments only prefill the studio; verify ownership and source
  // bounds server-side instead of trusting the query string.
  let suggestionSeed: DuplicateSeed | null = null;
  const startSeconds = Number(start);
  const endSeconds = Number(end);
  if (
    episode &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      episode,
    ) &&
    Number.isFinite(startSeconds) &&
    Number.isFinite(endSeconds) &&
    startSeconds >= 0 &&
    endSeconds > startSeconds &&
    endSeconds - startSeconds <= 180
  ) {
    const { data: source } = await supabase
      .from("episodes")
      .select("id, status, duration_seconds")
      .eq("id", episode)
      .eq("user_id", user.id)
      .maybeSingle();
    const duration = source?.duration_seconds;
    const { data: sourceClip } = await supabase
      .from("clips")
      .select("id")
      .eq("episode_id", episode)
      .eq("user_id", user.id)
      .eq("status", "completed")
      .not("transcript_segments", "is", null)
      .lte("start_seconds", startSeconds)
      .gte("end_seconds", endSeconds)
      .limit(1)
      .maybeSingle();
    if (
      source?.status === "ready" &&
      sourceClip &&
      (typeof duration !== "number" || endSeconds <= duration)
    ) {
      suggestionSeed = {
        episodeId: source.id,
        startSeconds,
        endSeconds,
        aspectRatio: null,
        styleKey: null,
        language: null,
        estimatedCostUsd: computeClipCost(endSeconds - startSeconds),
      };
    }
  }

  // Reclip and suggestion links may point to an older source outside the
  // initial 30-row selector window. Keep the preselected source visible so
  // the form's displayed choice always matches its submitted episode ID.
  const seedEpisodeId = dupSeed?.episodeId ?? suggestionSeed?.episodeId;
  if (seedEpisodeId && !episodes.some((item) => item.id === seedEpisodeId)) {
    const { data: seedEpisode } = await supabase
      .from("episodes")
      .select("id, title, source_type, created_at")
      .eq("id", seedEpisodeId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (seedEpisode) {
      episodes.unshift({
        id: seedEpisode.id,
        title: seedEpisode.title ?? "—",
        source_type: seedEpisode.source_type ?? "upload",
        created_at: seedEpisode.created_at,
      });
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
        initialDuplicateSeed={dupSeed ?? suggestionSeed}
      />
    </div>
  );
}
