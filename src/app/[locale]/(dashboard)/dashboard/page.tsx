import {
  ArrowRight,
  Captions,
  Clapperboard,
  Clock3,
  Film,
  FolderOpen,
  Gauge,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Link, redirect } from "@/i18n/navigation";
import { ACTIVE_JOB_STATUSES } from "@/lib/clips/history-query";
import { isClipsEnabled } from "@/lib/clips/feature-flag";
import type { ClipStatus } from "@/lib/clips/types";
import { createClient } from "@/lib/supabase/server";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type DashboardClip = {
  id: string;
  title: string | null;
  status: ClipStatus;
  created_at: string;
  aspect_ratio: string | null;
};

const CLIP_STATUS_STYLES: Record<ClipStatus, string> = {
  pending: "border-chart-3/25 bg-chart-3/10 text-chart-3",
  processing: "border-primary/30 bg-primary/10 text-primary",
  completing: "border-chart-2/30 bg-chart-2/10 text-chart-2",
  completed: "border-chart-2/30 bg-chart-2/10 text-chart-2",
  failed: "border-chart-4/30 bg-chart-4/10 text-chart-4",
};

function OverviewMetric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: "primary" | "cyan" | "mint";
}) {
  const toneClasses = {
    primary: "bg-primary/10 text-primary",
    cyan: "bg-chart-3/10 text-chart-3",
    mint: "bg-chart-2/10 text-chart-2",
  };

  return (
    <Card className="border-border/80 bg-card/75" size="sm">
      <CardContent className="flex items-center justify-between gap-4 pt-4">
        <div className="min-w-0">
          <p className="text-muted-foreground truncate text-xs font-medium">
            {label}
          </p>
          <p className="font-heading mt-2 text-3xl font-semibold tabular-nums">
            {value}
          </p>
        </div>
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-xl",
            toneClasses[tone],
          )}
        >
          <Icon className="size-[18px]" />
        </span>
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("clips.dashboard");
  const historyT = await getTranslations("clips.history");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect({ href: "/login", locale });
  }

  const [sources, clips, activeJobs, recentClipResult] = await Promise.all([
    supabase
      .from("episodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id),
    supabase
      .from("clips")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", [...ACTIVE_JOB_STATUSES]),
    supabase
      .from("clips")
      .select("id, title, status, created_at, aspect_ratio")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const isShortsEnabled = isClipsEnabled({ locale, userId: user.id });
  const newProjectHref = isShortsEnabled ? "/shorts" : "/clips/new";
  const formatCount = (count: number | null, error: unknown) =>
    error || count === null ? "—" : new Intl.NumberFormat(locale).format(count);
  const recentClips = (recentClipResult.data ??
    []) as unknown as DashboardClip[];
  const hasAnyActivity = (sources.count ?? 0) > 0 || (clips.count ?? 0) > 0;
  const activityUnavailable = Boolean(
    sources.error || clips.error || recentClipResult.error,
  );
  const statusLabels: Record<ClipStatus, string> = {
    pending: historyT("status_pending"),
    processing: historyT("status_processing"),
    completing: historyT("status_completing"),
    completed: historyT("status_completed"),
    failed: historyT("status_failed"),
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 sm:space-y-8">
      <header className="border-border/80 from-card via-card to-primary/10 relative overflow-hidden rounded-2xl border bg-gradient-to-br p-5 sm:p-7 lg:p-8">
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl space-y-3">
            <p className="text-primary text-[10px] font-semibold tracking-[0.2em] uppercase">
              CLIPSFLOW · {t("eyebrow")}
            </p>
            <h1 className="font-heading text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
              {t("title")}
            </h1>
            <p className="text-muted-foreground max-w-xl text-sm leading-relaxed sm:text-base">
              {t("description")}
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Link
              href={newProjectHref}
              className={cn(buttonVariants(), "min-h-10 gap-2")}
            >
              <Sparkles aria-hidden="true" className="size-4" />
              {t("new_project")}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <Link
              href="/clips"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "min-h-10 gap-2",
              )}
            >
              <FolderOpen aria-hidden="true" className="size-4" />
              {t("library_link")}
            </Link>
          </div>
        </div>
      </header>

      <section
        aria-label={t("quick_title")}
        className="grid gap-3 sm:grid-cols-3 sm:gap-4"
      >
        <OverviewMetric
          label={t("stat_sources")}
          value={formatCount(sources.count, sources.error)}
          icon={Film}
          tone="cyan"
        />
        <OverviewMetric
          label={t("stat_clips")}
          value={formatCount(clips.count, clips.error)}
          icon={Clapperboard}
          tone="primary"
        />
        <OverviewMetric
          label={t("stat_active")}
          value={formatCount(activeJobs.count, activeJobs.error)}
          icon={Clock3}
          tone="mint"
        />
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.85fr)]">
        <Card className="border-border/80 bg-card/70 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
            <div className="space-y-1">
              <p className="text-primary text-[10px] font-semibold tracking-[0.16em] uppercase">
                {t("eyebrow")}
              </p>
              <CardTitle className="font-heading text-lg font-semibold">
                {t("recent_title")}
              </CardTitle>
            </div>
            <Link
              href="/clips"
              className="text-primary focus-visible:ring-ring inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
            >
              {t("view_history")}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
          <CardContent className="pt-4">
            {recentClipResult.error ? (
              <p className="text-muted-foreground rounded-xl border border-dashed p-5 text-sm">
                {t("activity_unavailable")}
              </p>
            ) : recentClips.length > 0 ? (
              <ul className="divide-border divide-y">
                {recentClips.map((clip) => (
                  <li
                    key={clip.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="bg-primary/10 text-primary mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <Clapperboard aria-hidden="true" className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {clip.title?.trim() || t("untitled")}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                          }).format(new Date(clip.created_at))}
                          {clip.aspect_ratio
                            ? ` · ${t("format", { value: clip.aspect_ratio })}`
                            : ""}
                        </p>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
                        CLIP_STATUS_STYLES[clip.status],
                      )}
                    >
                      {statusLabels[clip.status]}
                    </span>
                  </li>
                ))}
              </ul>
            ) : hasAnyActivity || activityUnavailable ? (
              <p className="text-muted-foreground rounded-xl border border-dashed p-5 text-sm">
                {t("activity_unavailable")}
              </p>
            ) : (
              <div className="border-border/80 bg-background/35 rounded-xl border border-dashed px-5 py-7 text-center sm:py-9">
                <span className="bg-primary/10 text-primary mx-auto inline-flex size-11 items-center justify-center rounded-xl">
                  <Gauge aria-hidden="true" className="size-5" />
                </span>
                <h2 className="font-heading mt-4 text-base font-semibold">
                  {t("empty_title")}
                </h2>
                <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
                  {t("empty_body")}
                </p>
                <Link
                  href={newProjectHref}
                  className={cn(buttonVariants(), "mt-5 gap-2")}
                >
                  <Sparkles aria-hidden="true" className="size-4" />
                  {t("empty_cta")}
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card className="border-border/80 bg-card/70">
            <div className="px-5 pt-5 sm:px-6 sm:pt-6">
              <p className="text-primary text-[10px] font-semibold tracking-[0.16em] uppercase">
                {t("eyebrow")}
              </p>
              <CardTitle className="font-heading mt-1 text-lg font-semibold">
                {t("quick_title")}
              </CardTitle>
            </div>
            <CardContent className="space-y-3 pt-4">
              {isShortsEnabled ? (
                <Link
                  href="/shorts"
                  className="group border-border/80 bg-background/45 hover:border-primary/40 focus-visible:ring-ring flex min-h-20 items-center gap-3 rounded-xl border p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="bg-primary/10 text-primary inline-flex size-10 shrink-0 items-center justify-center rounded-lg">
                    <Sparkles aria-hidden="true" className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">
                      {t("shorts_title")}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
                      {t("shorts_description")}
                    </span>
                  </span>
                  <ArrowRight
                    aria-hidden="true"
                    className="text-muted-foreground group-hover:text-primary size-4 shrink-0 transition-colors"
                  />
                </Link>
              ) : null}
              <Link
                href="/clips/new"
                className="group border-border/80 bg-background/45 hover:border-chart-3/40 focus-visible:ring-ring flex min-h-20 items-center gap-3 rounded-xl border p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="bg-chart-3/10 text-chart-3 inline-flex size-10 shrink-0 items-center justify-center rounded-lg">
                  <Captions aria-hidden="true" className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {t("clip_title")}
                  </span>
                  <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
                    {t("clip_description")}
                  </span>
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="text-muted-foreground group-hover:text-chart-3 size-4 shrink-0 transition-colors"
                />
              </Link>
            </CardContent>
          </Card>

          <Card className="border-border/80 bg-card/70">
            <div className="px-5 pt-5 sm:px-6 sm:pt-6">
              <CardTitle className="font-heading text-base font-semibold">
                {t("flow_title")}
              </CardTitle>
              <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {t("flow_description")}
              </p>
            </div>
            <CardContent className="pt-4">
              <ol className="grid grid-cols-3 gap-2">
                {[
                  { label: t("flow_source"), icon: Film },
                  { label: t("flow_moments"), icon: Sparkles },
                  { label: t("flow_publish"), icon: Clapperboard },
                ].map(({ label, icon: Icon }, index) => (
                  <li
                    key={label}
                    className="border-border/70 bg-background/45 min-w-0 rounded-lg border p-3"
                  >
                    <span className="text-primary flex items-center gap-1.5 text-[10px] font-semibold">
                      <Icon aria-hidden="true" className="size-3.5" />0
                      {index + 1}
                    </span>
                    <span className="mt-2 block text-xs leading-snug font-medium">
                      {label}
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
