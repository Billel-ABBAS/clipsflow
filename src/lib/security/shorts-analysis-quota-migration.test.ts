import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261004123409_shorts_analysis_monthly_quota.sql",
  ),
  "utf8",
).replace(/\s+/gu, " ");

describe("Shorts monthly source-analysis quota migration", () => {
  it("keeps usage and reservation ledgers private to database functions", () => {
    for (const table of [
      "shorts_analysis_quota_usage",
      "shorts_analysis_quota_reservations",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`,
          "iu",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`,
          "iu",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated, service_role`,
          "iu",
        ),
      );
    }
  });

  it("reserves quota atomically after the idempotency check", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.shorts_submit_analysis_job_with_quota\([\s\S]*?p_quota_limit_source_seconds integer[\s\S]*?pg_catalog\.pg_advisory_xact_lock[\s\S]*?IF FOUND THEN[\s\S]*?INSERT INTO public\.shorts_analysis_quota_usage[\s\S]*?ON CONFLICT \(user_id, period_start\)[\s\S]*?consumed_source_seconds[\s\S]*?reserved_source_seconds[\s\S]*?<= p_quota_limit_source_seconds[\s\S]*?analysis_quota_exceeded/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.shorts_submit_analysis_job\( uuid, uuid, text, integer, text, boolean, uuid \) FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.shorts_submit_analysis_job_with_quota\([^)]+\) TO service_role/i,
    );
  });

  it("adjusts the reservation against a live lease before provider work", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.shorts_adjust_analysis_quota\([\s\S]*?p_lease_token uuid[\s\S]*?job\.status = 'processing'[\s\S]*?job\.lease_token = p_lease_token[\s\S]*?source_duration_seconds = p_actual_duration_seconds/i,
    );
    expect(migration).toMatch(
      /shorts_analysis_quota_finalize_status AFTER UPDATE OF status ON public\.shorts_analysis_jobs/i,
    );
    expect(migration).toMatch(
      /NEW\.status = 'completed'[\s\S]*?status = 'consumed'/i,
    );
    expect(migration).toMatch(
      /NEW\.status NOT IN \('completed', 'failed'\)[\s\S]*?ELSE[\s\S]*?status = 'released'/i,
    );
    expect(migration).toMatch(
      /shorts_analysis_quota_release_deleted_reservation AFTER DELETE ON public\.shorts_analysis_quota_reservations/i,
    );
  });
});
