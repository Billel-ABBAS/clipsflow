import { describe, expect, it } from "vitest";

import {
  ACTIVE_JOB_STATUSES,
  HISTORY_STATUSES,
  historyQueryString,
  isCurrentRenderFinalizing,
  isHistoryFiltered,
  parseHistoryFilters,
  resolveHistoryJobStatus,
  resolveHistoryPage,
} from "./history-query";

describe("history query parsing", () => {
  it("shows finalization only for the active render attempt", () => {
    expect(
      isCurrentRenderFinalizing("processing", "render", "completing", 2, 2),
    ).toBe(true);
    expect(
      isCurrentRenderFinalizing("processing", "render", "completing", 1, 2),
    ).toBe(false);
    expect(
      resolveHistoryJobStatus("processing", "render", "completing", 2, 2),
    ).toBe("completing");
    expect(
      resolveHistoryJobStatus("processing", "render", "completing", 1, 2),
    ).toBe("processing");
    expect(
      resolveHistoryJobStatus("processing", "transcribe", "completing", 2, 2),
    ).toBe("processing");
    expect(
      resolveHistoryJobStatus("completed", "render", "completing", 2, 2),
    ).toBe("completed");
  });

  it("only treats queued and running jobs as active polling work", () => {
    expect(ACTIVE_JOB_STATUSES).toEqual(["pending", "processing"]);
    expect(ACTIVE_JOB_STATUSES).not.toContain("completed");
    expect(ACTIVE_JOB_STATUSES).not.toContain("failed");
  });

  it("bounds and normalizes search, status, format, dates, sort and page", () => {
    expect(
      parseHistoryFilters({
        q: `  ${"a".repeat(120)}  `,
        status: "failed",
        aspect: "9:16",
        from: "2026-02-01",
        to: "2026-02-28",
        sort: "oldest",
        page: "3",
        source_page: "2",
        job_page: "4",
      }),
    ).toEqual({
      q: "a".repeat(100),
      status: "failed",
      aspect: "9:16",
      from: "2026-02-01",
      to: "2026-02-28",
      sort: "oldest",
      page: 3,
      sourcePage: 2,
      jobPage: 4,
    });
  });

  it("rejects invalid values and caps the page number", () => {
    expect(
      parseHistoryFilters({
        status: "unknown",
        aspect: "3:2",
        from: "2026-02-30",
        to: "2026/02/28",
        sort: "random",
        page: "999999999",
        source_page: "-1",
        job_page: "invalid",
      }),
    ).toEqual({
      q: "",
      status: "all",
      aspect: "all",
      from: "",
      to: "",
      sort: "recent",
      page: 10_000,
      sourcePage: 0,
      jobPage: 0,
    });
  });

  it("retains active filters in pagination links and omits defaults", () => {
    const filters = parseHistoryFilters({
      q: "launch",
      status: "processing",
      aspect: "1:1",
      page: "1",
      source_page: "2",
      job_page: "3",
    });
    expect(historyQueryString(filters, 2)).toBe(
      "q=launch&status=processing&aspect=1%3A1&page=2&source_page=2&job_page=3",
    );
    expect(isHistoryFiltered(filters)).toBe(true);
    expect(historyQueryString(parseHistoryFilters({}), 0)).toBe("");
    expect(isHistoryFiltered(parseHistoryFilters({ sort: "oldest" }))).toBe(
      false,
    );
  });

  it("preserves each supported status and clamps pages for 0, 1, and over 50 clips", () => {
    for (const status of HISTORY_STATUSES) {
      expect(parseHistoryFilters({ status }).status).toBe(status);
    }

    expect(resolveHistoryPage(0, 4)).toEqual({
      effectivePage: 0,
      totalPages: 0,
    });
    expect(resolveHistoryPage(1, 4)).toEqual({
      effectivePage: 0,
      totalPages: 1,
    });
    expect(resolveHistoryPage(51, 4)).toEqual({
      effectivePage: 2,
      totalPages: 3,
    });
    expect(resolveHistoryPage(51, 1)).toEqual({
      effectivePage: 1,
      totalPages: 3,
    });
  });
});
