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
import { EpisodeSuggestionsButton } from "@/components/clips/EpisodeSuggestionsButton";
import { HistoryAutoRefresh } from "@/components/clips/HistoryAutoRefresh";
import { OnboardingHero } from "@/components/clips/OnboardingHero";
import { QuotaIndicator } from "@/components/clips/QuotaIndicator";
import { WatermarkNotice } from "@/components/clips/WatermarkNotice";
import { buttonVariants } from "@/components/ui/button";
import { PageHeading } from "@/components/ui/PageHeading";
import { Link, redirect } from "@/i18n/navigation";
import {
  ACTIVE_JOB_STATUSES,
  HISTORY_PAGE_SIZE,
  HISTORY_STATUSES,
  historyQueryString,
  isHistoryFiltered,
  parseHistoryFilters,
  resolveHistoryPage,
  resolveHistoryJobStatus,
  type HistoryFilters,
  type SearchParamsRecord,
} from "@/lib/clips/history-query";
import { QUOTAS_SECONDS, resolvePlan } from "@/lib/clips/quota";
import { refreshClipUrls } from "@/lib/clips/refresh-urls";
import { resolveYouTubeOAuthFeedback } from "@/lib/youtube/oauth-feedback";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type EpisodeRow = {
  id: string;
  title: string;
  source_type: "upload" | "url";
  status: string;
  error_message: string | null;
  created_at: string;
};

type JobRow = {
  id: string;
  type: "render" | "transcribe" | "clip_extract";
  status: "pending" | "processing" | "completed" | "failed";
  attempt_count: number;
  render_stage: string | null;
  render_stage_attempt_count: number | null;
  error_message: string | null;
  created_at: string;
  episode_id: string | null;
  clip_id: string | null;
  episodes: { title: string | null } | null;
};

function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function startOfUtcDay(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toISOString();
}

function startOfNextUtcDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

async function HistoryFiltersForm({
  filters,
  locale,
  count,
}: {
  filters: HistoryFilters;
  locale: string;
  count: number;
}): Promise<React.JSX.Element> {
  const t = await getTranslations("clips.history");
  const filtered = isHistoryFiltered(filters);
  return (
    <div className="border-border bg-muted/20 space-y-3 rounded-xl border p-4">
      <form
        action={`/${locale}/clips`}
        method="get"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
      >
        <label className="space-y-1 text-xs lg:col-span-2">
          <span className="text-muted-foreground">{t("search")}</span>
          <input
            type="search"
            name="q"
            maxLength={100}
            defaultValue={filters.q}
            placeholder={t("search_placeholder")}
            className="border-border bg-background text-foreground h-9 w-full rounded-md border px-3 text-sm"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("status")}</span>
          <select
            name="status"
            defaultValue={filters.status}
            className="border-border bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="all">{t("status_all")}</option>
            {HISTORY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(
                  (
                    {
                      pending: "status_pending",
                      processing: "status_processing",
                      completing: "status_completing",
                      completed: "status_completed",
                      failed: "status_failed",
                    } as const
                  )[status],
                )}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("aspect")}</span>
          <select
            name="aspect"
            defaultValue={filters.aspect}
            className="border-border bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="all">{t("aspect_all")}</option>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="4:5">4:5</option>
            <option value="16:9">16:9</option>
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("from")}</span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            className="border-border bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("to")}</span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            className="border-border bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm"
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("sort")}</span>
          <select
            name="sort"
            defaultValue={filters.sort}
            className="border-border bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="recent">{t("sort_recent")}</option>
            <option value="oldest">{t("sort_oldest")}</option>
            <option value="hook_desc">{t("sort_score")}</option>
          </select>
        </label>
        <div className="flex items-end gap-2 lg:col-span-2">
          <button type="submit" className={cn(buttonVariants(), "h-9")}>
            {t("apply")}
          </button>
          {filtered ? (
            <a
              href={`/${locale}/clips`}
              className={cn(buttonVariants({ variant: "outline" }), "h-9")}
            >
              {t("reset")}
            </a>
          ) : null}
        </div>
      </form>
      <p className="text-muted-foreground text-xs" aria-live="polite">
        {t("results", { count })}
      </p>
    </div>
  );
}

async function HistoryPagination({
  filters,
  locale,
  page,
  totalPages,
}: {
  filters: HistoryFilters;
  locale: string;
  page: number;
  totalPages: number;
}): Promise<React.JSX.Element | null> {
  const t = await getTranslations("clips.history");
  if (totalPages <= 1) return null;
  const href = (targetPage: number) => {
    const query = historyQueryString(filters, targetPage);
    return `/${locale}/clips${query ? `?${query}` : ""}`;
  };
  return (
    <nav
      aria-label={t("pagination_label")}
      className="flex items-center justify-between gap-3"
    >
      {page > 0 ? (
        <a
          href={href(page - 1)}
          className={cn(buttonVariants({ variant: "outline" }), "h-9")}
        >
          {t("previous")}
        </a>
      ) : (
        <span />
      )}
      <span className="text-muted-foreground text-sm">
        {t("page", { current: page + 1, total: totalPages })}
      </span>
      {page + 1 < totalPages ? (
        <a
          href={href(page + 1)}
          className={cn(buttonVariants({ variant: "outline" }), "h-9")}
        >
          {t("next")}
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}

async function ActivityPagination({
  filters,
  locale,
  totalPages,
  kind,
}: {
  filters: HistoryFilters;
  locale: string;
  totalPages: number;
  kind: "sources" | "jobs";
}): Promise<React.JSX.Element | null> {
  const t = await getTranslations("clips.history");
  const page = kind === "sources" ? filters.sourcePage : filters.jobPage;
  if (totalPages <= 1) return null;

  const href = (targetPage: number) => {
    const nextFilters =
      kind === "sources"
        ? { ...filters, sourcePage: targetPage }
        : { ...filters, jobPage: targetPage };
    const query = historyQueryString(nextFilters);
    return `/${locale}/clips${query ? `?${query}` : ""}`;
  };

  return (
    <nav
      aria-label={
        kind === "sources"
          ? t("sources_pagination_label")
          : t("jobs_pagination_label")
      }
      className="border-border flex items-center justify-between gap-3 border-t pt-3"
    >
      {page > 0 ? (
        <a
          href={href(page - 1)}
          className={cn(buttonVariants({ variant: "outline" }), "h-9")}
        >
          {t("previous")}
        </a>
      ) : (
        <span />
      )}
      <span className="text-muted-foreground text-sm">
        {t("page", { current: page + 1, total: totalPages })}
      </span>
      {page + 1 < totalPages ? (
        <a
          href={href(page + 1)}
          className={cn(buttonVariants({ variant: "outline" }), "h-9")}
        >
          {t("next")}
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}

async function ActivitySections({
  episodes,
  jobs,
  transcriptEpisodeIds,
  locale,
  filters,
  sourceTotalPages,
  jobTotalPages,
  sourceError,
  jobError,
}: {
  episodes: EpisodeRow[];
  jobs: JobRow[];
  transcriptEpisodeIds: Set<string>;
  locale: string;
  filters: HistoryFilters;
  sourceTotalPages: number;
  jobTotalPages: number;
  sourceError: boolean;
  jobError: boolean;
}): Promise<React.JSX.Element> {
  const t = await getTranslations("clips.history");
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  const episodeTitles = new Map(
    episodes.map((episode) => [episode.id, episode.title]),
  );
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section
        aria-labelledby="clips-sources-heading"
        className="border-border space-y-3 rounded-xl border p-4"
      >
        <h2
          id="clips-sources-heading"
          className="font-heading text-lg font-medium"
        >
          {t("sources_title")}
        </h2>
        {sourceError ? (
          <p className="text-muted-foreground text-sm">{t("activity_error")}</p>
        ) : episodes.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("none")}</p>
        ) : (
          <ul className="divide-border divide-y">
            {episodes.map((episode) => (
              <li
                key={episode.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">
                    {episode.title}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {episode.source_type === "upload"
                      ? t("source_upload")
                      : t("source_url")}{" "}
                    ·{" "}
                    {t(
                      episode.status === "pending"
                        ? "episode_pending"
                        : episode.status === "processing"
                          ? "episode_processing"
                          : episode.status === "failed"
                            ? "episode_failed"
                            : "episode_ready",
                    )}{" "}
                    · {formatDate(episode.created_at)}
                  </p>
                  {episode.status === "failed" ? (
                    <p className="text-xs text-red-500">
                      {t("episode_failed_detail")}
                    </p>
                  ) : null}
                </div>
                {transcriptEpisodeIds.has(episode.id) ? (
                  <EpisodeSuggestionsButton episodeId={episode.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <ActivityPagination
          filters={filters}
          locale={locale}
          totalPages={sourceTotalPages}
          kind="sources"
        />
      </section>

      <section
        aria-labelledby="clips-jobs-heading"
        className="border-border space-y-3 rounded-xl border p-4"
      >
        <h2
          id="clips-jobs-heading"
          className="font-heading text-lg font-medium"
        >
          {t("jobs_title")}
        </h2>
        {jobError ? (
          <p className="text-muted-foreground text-sm">{t("activity_error")}</p>
        ) : jobs.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("none")}</p>
        ) : (
          <ul className="divide-border divide-y">
            {jobs.map((job) => {
              const visibleStatus = resolveHistoryJobStatus(
                job.status,
                job.type,
                job.render_stage,
                job.render_stage_attempt_count,
                job.attempt_count,
              );
              const active =
                visibleStatus === "pending" ||
                visibleStatus === "processing" ||
                visibleStatus === "completing";
              const statusKey =
                visibleStatus === "pending"
                  ? "status_pending"
                  : visibleStatus === "completing"
                    ? "status_completing"
                    : visibleStatus === "processing"
                      ? "status_processing"
                      : visibleStatus === "completed"
                        ? "status_completed"
                        : visibleStatus === "failed"
                          ? "status_failed"
                          : "status_pending";
              const jobTypeKey =
                job.type === "clip_extract"
                  ? "job_extract"
                  : job.type === "transcribe"
                    ? "job_transcribe"
                    : "job_render";
              return (
                <li
                  key={job.id}
                  className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="truncate text-sm font-medium">
                      {t(jobTypeKey)} ·{" "}
                      {job.episode_id
                        ? (episodeTitles.get(job.episode_id) ??
                          job.episodes?.title ??
                          t("source_unknown"))
                        : t("source_unknown")}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(job.created_at))}{" "}
                      · {t("attempts", { count: job.attempt_count })}
                    </p>
                    {job.status === "failed" ? (
                      <p className="text-xs text-red-500">
                        {t("generic_error")}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={
                      active
                        ? "text-xs font-medium text-amber-600"
                        : "text-muted-foreground text-xs"
                    }
                  >
                    {t(statusKey)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <ActivityPagination
          filters={filters}
          locale={locale}
          totalPages={jobTotalPages}
          kind="jobs"
        />
      </section>
    </div>
  );
}

export default async function ClipsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParamsRecord>;
}) {
  const [{ locale }, rawSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  setRequestLocale(locale);
  const t = await getTranslations("clips");
  const historyT = await getTranslations("clips.history");
  const filters = parseHistoryFilters(rawSearchParams);
  const youtubeOAuthFeedback = resolveYouTubeOAuthFeedback(rawSearchParams);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: "/login", locale });
    return null;
  }

  const page = filters.page;
  const makeClipQuery = (pageIndex: number) => {
    let query = supabase
      .from("clips")
      .select(CLIP_SELECT_COLUMNS, { count: "exact" })
      .eq("user_id", user.id);
    if (filters.q) {
      query = query.ilike("episodes.title", `%${escapeLikeValue(filters.q)}%`);
    }
    if (filters.status === "processing") {
      query = query.in("status", ["pending", "processing", "completing"]);
    } else if (filters.status !== "all") {
      query = query.eq("status", filters.status);
    }
    if (filters.aspect !== "all")
      query = query.eq("aspect_ratio", filters.aspect);
    if (filters.from)
      query = query.gte("created_at", startOfUtcDay(filters.from));
    if (filters.to)
      query = query.lt("created_at", startOfNextUtcDay(filters.to));
    if (filters.sort === "oldest") {
      query = query.order("created_at", { ascending: true });
    } else if (filters.sort === "hook_desc") {
      query = query
        .order("score", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }
    const firstRow = pageIndex * HISTORY_PAGE_SIZE;
    return query.range(firstRow, firstRow + HISTORY_PAGE_SIZE - 1);
  };

  const makeEpisodeQuery = (pageIndex: number) => {
    let query = supabase
      .from("episodes")
      .select("id, title, source_type, status, error_message, created_at", {
        count: "exact",
      })
      .eq("user_id", user.id);
    if (filters.q) {
      query = query.ilike("title", `%${escapeLikeValue(filters.q)}%`);
    }
    if (filters.from)
      query = query.gte("created_at", startOfUtcDay(filters.from));
    if (filters.to)
      query = query.lt("created_at", startOfNextUtcDay(filters.to));
    const firstRow = pageIndex * HISTORY_PAGE_SIZE;
    return query
      .order("created_at", { ascending: false })
      .range(firstRow, firstRow + HISTORY_PAGE_SIZE - 1);
  };

  const makeJobQuery = (pageIndex: number) => {
    const episodeJoin = filters.q ? "episodes!inner(title)" : "episodes(title)";
    let query = supabase
      .from("jobs")
      .select(
        `id, type, status, attempt_count, render_stage, render_stage_attempt_count, error_message, created_at, episode_id, clip_id, ${episodeJoin}`,
        { count: "exact" },
      )
      .eq("user_id", user.id);
    if (filters.q)
      query = query.ilike("episodes.title", `%${escapeLikeValue(filters.q)}%`);
    if (filters.from)
      query = query.gte("created_at", startOfUtcDay(filters.from));
    if (filters.to)
      query = query.lt("created_at", startOfNextUtcDay(filters.to));
    const firstRow = pageIndex * HISTORY_PAGE_SIZE;
    return query
      .order("created_at", { ascending: false })
      .range(firstRow, firstRow + HISTORY_PAGE_SIZE - 1);
  };

  const [
    clipResult,
    episodeResult,
    jobResult,
    profileResult,
    activeClipResult,
    activeJobResult,
    activeEpisodeResult,
  ] = await Promise.all([
    makeClipQuery(page),
    makeEpisodeQuery(filters.sourcePage),
    makeJobQuery(filters.jobPage),
    supabase
      .from("profiles")
      .select("id, clip_seconds_used_this_month, clip_quota_reset_at, plan")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("clips")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", ["pending", "processing", "completing"]),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", [...ACTIVE_JOB_STATUSES]),
    supabase
      .from("episodes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", ["pending", "processing"]),
  ]);

  let effectivePage = page;
  let currentClipResult = clipResult;
  const { effectivePage: resolvedPage, totalPages } = resolveHistoryPage(
    clipResult.count,
    page,
  );
  if (!clipResult.error && resolvedPage !== page) {
    effectivePage = resolvedPage;
    currentClipResult = await makeClipQuery(effectivePage);
  } else {
    effectivePage = resolvedPage;
  }

  let effectiveSourcePage = filters.sourcePage;
  let currentEpisodeResult = episodeResult;
  const sourcePageInfo = resolveHistoryPage(
    episodeResult.count,
    filters.sourcePage,
  );
  if (
    !episodeResult.error &&
    sourcePageInfo.effectivePage !== filters.sourcePage
  ) {
    effectiveSourcePage = sourcePageInfo.effectivePage;
    currentEpisodeResult = await makeEpisodeQuery(effectiveSourcePage);
  }

  let effectiveJobPage = filters.jobPage;
  let currentJobResult = jobResult;
  const jobPageInfo = resolveHistoryPage(jobResult.count, filters.jobPage);
  if (!jobResult.error && jobPageInfo.effectivePage !== filters.jobPage) {
    effectiveJobPage = jobPageInfo.effectivePage;
    currentJobResult = await makeJobQuery(effectiveJobPage);
  }

  const historyError = Boolean(currentClipResult.error);
  const episodeRows = (currentEpisodeResult.data ??
    []) as unknown as EpisodeRow[];
  const episodeIds = episodeRows.map((episode) => episode.id);
  const jobRows = (currentJobResult.data ?? []) as unknown as JobRow[];
  const transcriptResult = episodeIds.length
    ? await supabase
        .from("clips")
        .select("episode_id")
        .eq("user_id", user.id)
        .eq("status", "completed")
        .not("transcript_segments", "is", null)
        .in("episode_id", episodeIds)
    : { data: [], error: null };
  const transcriptEpisodeIds = new Set(
    (transcriptResult.data ?? []).map((row) => row.episode_id as string),
  );
  const admin = createAdminClient();
  const { data: collectionRows, error: collectionError } = await admin
    .from("clip_collections")
    .select("id, name, clip_collection_items(clip_id)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  let clips: GalleryClipRow[] = [];
  if (!historyError) {
    const refreshed = await refreshClipUrls(
      supabase,
      (currentClipResult.data ?? []) as unknown as ClipRowRaw[],
    );
    const collectionByClip = new Map<string, string>();
    for (const row of collectionRows ?? []) {
      const items = row.clip_collection_items as { clip_id: string }[] | null;
      for (const item of items ?? [])
        collectionByClip.set(item.clip_id, row.id);
    }
    clips = refreshed.map((row) => ({
      ...toGalleryRow(row),
      collection_id: collectionByClip.get(row.id) ?? null,
    }));
  }

  const plan = resolvePlan(profileResult.data);
  const secondsUsed = profileResult.data?.clip_seconds_used_this_month ?? 0;
  const secondsLimit = QUOTAS_SECONDS[plan] ?? 0;
  const resetAt = profileResult.data?.clip_quota_reset_at ?? null;
  const activeWork =
    (activeClipResult.count ?? 0) > 0 ||
    (activeJobResult.count ?? 0) > 0 ||
    (activeEpisodeResult.count ?? 0) > 0 ||
    clips.some((clip) =>
      ["pending", "processing", "completing"].includes(clip.status),
    ) ||
    jobRows.some(
      (job) => job.status === "pending" || job.status === "processing",
    ) ||
    episodeRows.some(
      (episode) =>
        episode.status === "pending" || episode.status === "processing",
    );
  const sourceError = Boolean(
    currentEpisodeResult.error || transcriptResult.error,
  );
  const jobError = Boolean(currentJobResult.error);
  const filtered = isHistoryFiltered(filters);

  const sourceCount = currentEpisodeResult.count ?? 0;
  const clipCount = currentClipResult.count ?? 0;
  const visibleEpisodes = episodeRows;
  const visibleJobs = jobRows;
  const navigationFilters: HistoryFilters = {
    ...filters,
    page: effectivePage,
    sourcePage: effectiveSourcePage,
    jobPage: effectiveJobPage,
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <HistoryAutoRefresh userId={user.id} active={activeWork} />
      <PageHeading
        eyebrow={historyT("eyebrow")}
        title={historyT("title")}
        description={t("page_subtitle")}
        actions={
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
        }
      />

      {youtubeOAuthFeedback ? (
        <p
          className="border-border bg-muted/20 rounded-lg border p-3 text-sm"
          role={youtubeOAuthFeedback === "connected" ? "status" : "alert"}
        >
          {youtubeOAuthFeedback === "connected"
            ? t("youtube_oauth_connected")
            : youtubeOAuthFeedback === "cancelled"
              ? t("youtube_oauth_cancelled")
              : t("youtube_oauth_error")}
        </p>
      ) : null}

      <WatermarkNotice plan={plan} />
      <HistoryFiltersForm filters={filters} locale={locale} count={clipCount} />

      {historyError ? (
        <section
          className="border-border space-y-3 rounded-xl border p-6"
          role="alert"
        >
          <h2 className="font-medium">{historyT("load_error_title")}</h2>
          <p className="text-muted-foreground text-sm">
            {historyT("load_error_body")}
          </p>
          <a
            href={`/${locale}/clips`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            {historyT("reload")}
          </a>
        </section>
      ) : filtered && clips.length === 0 ? (
        <section className="border-border space-y-2 rounded-xl border border-dashed p-8 text-center">
          <h2 className="font-medium">{historyT("empty_filter_title")}</h2>
          <p className="text-muted-foreground text-sm">
            {historyT("empty_filter_body")}
          </p>
        </section>
      ) : (
        <>
          {clipCount === 0 &&
          sourceCount === 0 &&
          !filtered &&
          !currentEpisodeResult.error ? (
            <OnboardingHero />
          ) : null}
          {collectionError ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t("library.unavailable")}
            </p>
          ) : null}
          {clips.length > 0 ? (
            <ClipsGallery
              clips={clips}
              hideToolbar
              showLibraryControls={!collectionError}
              collections={(collectionRows ?? []).map((row) => ({
                id: row.id as string,
                name: row.name as string,
              }))}
            />
          ) : clipCount === 0 ? (
            <ClipsGallery clips={[]} hideToolbar />
          ) : null}
        </>
      )}

      {!historyError ? (
        <HistoryPagination
          filters={navigationFilters}
          locale={locale}
          page={effectivePage}
          totalPages={totalPages}
        />
      ) : null}

      <ActivitySections
        episodes={visibleEpisodes}
        jobs={visibleJobs}
        transcriptEpisodeIds={transcriptEpisodeIds}
        locale={locale}
        filters={navigationFilters}
        sourceTotalPages={sourcePageInfo.totalPages}
        jobTotalPages={jobPageInfo.totalPages}
        sourceError={sourceError}
        jobError={jobError}
      />
    </div>
  );
}
