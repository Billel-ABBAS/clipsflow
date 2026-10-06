import { createHash } from "node:crypto";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = {
  referrer: "no-referrer",
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
};

export default async function SharedClipPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const admin = createAdminClient();
  const { data: share } = await admin
    .from("clip_share_links")
    .select("clip_id")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (!share) notFound();

  const { data: clip } = await admin
    .from("clips")
    .select(
      "status, title_override, video_storage_path, captions_vtt_storage_path, episodes!inner(title)",
    )
    .eq("id", share.clip_id)
    .eq("status", "completed")
    .maybeSingle();
  if (!clip?.video_storage_path) notFound();

  const { data: video } = await admin.storage
    .from("clip-outputs")
    .createSignedUrl(clip.video_storage_path, 5 * 60);
  if (!video?.signedUrl) notFound();

  let captionsUrl: string | null = null;
  if (clip.captions_vtt_storage_path) {
    const { data: captions } = await admin.storage
      .from("clip-outputs")
      .createSignedUrl(clip.captions_vtt_storage_path, 5 * 60);
    captionsUrl = captions?.signedUrl ?? null;
  }

  const t = await getTranslations({ locale, namespace: "clips.share" });
  const episode = clip.episodes as unknown as { title: string | null } | null;
  const title = clip.title_override || episode?.title || t("shared_video");

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-4xl items-center px-4 py-10">
      <article className="border-border bg-card w-full space-y-5 rounded-xl border p-5 shadow-sm sm:p-8">
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            ClipsFlow
          </p>
          <h1 className="font-heading text-2xl font-semibold">{title}</h1>
          <p className="text-muted-foreground text-sm">{t("shared_video")}</p>
        </div>
        <video
          src={video.signedUrl}
          controls
          playsInline
          preload="metadata"
          className="bg-muted aspect-video w-full rounded-lg"
        />
        <p className="text-muted-foreground text-xs">{t("link_access_note")}</p>
        <div className="flex items-center gap-3">
          <a
            href={video.signedUrl}
            download
            className="border-border bg-background hover:bg-muted rounded-md border px-3 py-2 text-sm font-medium"
          >
            {t("download_video")}
          </a>
          {captionsUrl ? (
            <a
              href={captionsUrl}
              download
              className="border-border bg-background hover:bg-muted rounded-md border px-3 py-2 text-sm font-medium"
            >
              {t("download_captions")}
            </a>
          ) : null}
        </div>
      </article>
    </main>
  );
}
