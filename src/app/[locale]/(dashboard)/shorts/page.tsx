import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import {
  ShortsStudio,
  type ShortsStudioEpisode,
} from "@/components/shorts/ShortsStudio";
import { redirect } from "@/i18n/navigation";
import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { resolveShortsProviderCapabilitiesForServer } from "@/lib/shorts/provider-capabilities-server";
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
      viewerName={
        typeof user.user_metadata?.full_name === "string"
          ? user.user_metadata.full_name.slice(0, 100)
          : undefined
      }
      episodes={episodes}
      providerCapabilities={await resolveShortsProviderCapabilitiesForServer()}
      sourceLoadError={Boolean(error)}
    />
  );
}
