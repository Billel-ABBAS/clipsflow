import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import {
  ShortsStudio,
  type ShortsStudioEpisode,
} from "@/components/shorts/ShortsStudio";
import { redirect } from "@/i18n/navigation";
import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { resolveShortsProviderCapabilities } from "@/lib/shorts/provider-capabilities";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ShortsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({
      href: { pathname: "/login", query: { next: "/shorts" } },
      locale,
    });
    return null;
  }
  if (!isClipsEnabled({ locale, userId: user.id })) {
    notFound();
  }

  const { data: episodeRows, error } = await supabase
    .from("episodes")
    .select("id, title, source_type, duration_seconds, status, created_at")
    .eq("user_id", user.id)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(100);

  const episodes: ShortsStudioEpisode[] = (episodeRows ?? []).map(
    (episode) => ({
      id: episode.id,
      title: episode.title || "—",
      sourceType: episode.source_type || "upload",
      durationSeconds:
        typeof episode.duration_seconds === "number"
          ? episode.duration_seconds
          : null,
      status: episode.status || "ready",
      createdAt: episode.created_at,
    }),
  );

  return (
    <ShortsStudio
      locale={locale}
      episodes={episodes}
      providerCapabilities={resolveShortsProviderCapabilities({
        CLIPS_AI_BUDGET_AUTHORIZED: process.env.CLIPS_AI_BUDGET_AUTHORIZED,
        CLIPS_CREATIVE_DIRECTOR_ENABLED:
          process.env.CLIPS_CREATIVE_DIRECTOR_ENABLED,
        CLIPS_CREATIVE_DIRECTOR_MODEL:
          process.env.CLIPS_CREATIVE_DIRECTOR_MODEL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        NEXT_PUBLIC_ANTHROPIC_API_KEY:
          process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY,
        CLIPS_ELEVENLABS_ENABLED: process.env.CLIPS_ELEVENLABS_ENABLED,
        CLIPS_ELEVENLABS_MUSIC_MODEL: process.env.CLIPS_ELEVENLABS_MUSIC_MODEL,
        CLIPS_ELEVENLABS_SOUND_MODEL: process.env.CLIPS_ELEVENLABS_SOUND_MODEL,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        NEXT_PUBLIC_ELEVENLABS_API_KEY:
          process.env.NEXT_PUBLIC_ELEVENLABS_API_KEY,
      })}
      sourceLoadError={Boolean(error)}
    />
  );
}
