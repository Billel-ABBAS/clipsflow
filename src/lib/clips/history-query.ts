export const HISTORY_PAGE_SIZE = 20;
export const ACTIVE_JOB_STATUSES = ["pending", "processing"] as const;

export const HISTORY_STATUSES = [
  "pending",
  "processing",
  "completing",
  "completed",
  "failed",
] as const;
export type HistoryStatusValue = (typeof HISTORY_STATUSES)[number];

export type HistoryStatus = (typeof HISTORY_STATUSES)[number] | "all";
export type HistoryAspect = "all" | "9:16" | "1:1" | "4:5" | "16:9";
export type HistorySort = "recent" | "oldest" | "hook_desc";

export interface HistoryFilters {
  q: string;
  status: HistoryStatus;
  aspect: HistoryAspect;
  from: string;
  to: string;
  sort: HistorySort;
  page: number;
  sourcePage: number;
  jobPage: number;
}

/** Resolve a durable worker stage only for the render attempt that wrote it. */
export function isCurrentRenderFinalizing(
  jobStatus: string,
  jobType: string,
  renderStage: string | null,
  renderStageAttemptCount: number | null,
  attemptCount: number,
): boolean {
  return (
    jobType === "render" &&
    jobStatus === "processing" &&
    renderStage === "completing" &&
    renderStageAttemptCount === attemptCount
  );
}

export function resolveHistoryJobStatus(
  jobStatus: string,
  jobType: string,
  renderStage: string | null,
  renderStageAttemptCount: number | null,
  attemptCount: number,
): HistoryStatusValue {
  if (
    isCurrentRenderFinalizing(
      jobStatus,
      jobType,
      renderStage,
      renderStageAttemptCount,
      attemptCount,
    )
  ) {
    return "completing";
  }

  return HISTORY_STATUSES.includes(jobStatus as HistoryStatusValue)
    ? (jobStatus as HistoryStatusValue)
    : "pending";
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

export function resolveHistoryPage(
  count: number | null,
  requestedPage: number,
  pageSize = HISTORY_PAGE_SIZE,
): { effectivePage: number; totalPages: number } {
  const totalPages = Math.ceil(Math.max(0, count ?? 0) / pageSize);
  return {
    effectivePage:
      totalPages === 0
        ? 0
        : Math.min(Math.max(0, requestedPage), totalPages - 1),
    totalPages,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function parsePage(value: string): number {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 0;
}

function validDate(value: string): string {
  if (!DATE_RE.test(value)) return "";
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? ""
    : value;
}

export function parseHistoryFilters(
  params: SearchParamsRecord,
): HistoryFilters {
  const rawStatus = first(params.status);
  const rawAspect = first(params.aspect);
  const rawSort = first(params.sort);

  return {
    q: first(params.q).trim().slice(0, 100),
    status: HISTORY_STATUSES.includes(
      rawStatus as (typeof HISTORY_STATUSES)[number],
    )
      ? (rawStatus as HistoryStatus)
      : "all",
    aspect: ["9:16", "1:1", "4:5", "16:9"].includes(rawAspect)
      ? (rawAspect as HistoryAspect)
      : "all",
    from: validDate(first(params.from)),
    to: validDate(first(params.to)),
    sort: ["oldest", "hook_desc"].includes(rawSort)
      ? (rawSort as HistorySort)
      : "recent",
    page: parsePage(first(params.page)),
    sourcePage: parsePage(first(params.source_page)),
    jobPage: parsePage(first(params.job_page)),
  };
}

export function historyQueryString(
  filters: HistoryFilters,
  page = filters.page,
): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.aspect !== "all") params.set("aspect", filters.aspect);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.sort !== "recent") params.set("sort", filters.sort);
  if (page > 0) params.set("page", String(page));
  if (filters.sourcePage > 0)
    params.set("source_page", String(filters.sourcePage));
  if (filters.jobPage > 0) params.set("job_page", String(filters.jobPage));
  return params.toString();
}

export function isHistoryFiltered(filters: HistoryFilters): boolean {
  return Boolean(
    filters.q ||
    filters.status !== "all" ||
    filters.aspect !== "all" ||
    filters.from ||
    filters.to,
  );
}
