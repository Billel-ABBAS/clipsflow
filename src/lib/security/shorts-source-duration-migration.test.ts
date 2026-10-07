import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261007061255_shorts_source_duration_bounds_1m_4h.sql",
  ),
  "utf8",
).replace(/\s+/gu, " ");
const databaseTest = readFileSync(
  join(process.cwd(), "supabase/tests/shorts_source_duration.sql"),
  "utf8",
).replace(/\s+/gu, " ");
const quotaConstraintCleanup = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261007090445_shorts_quota_bounds_legacy_constraint_cleanup.sql",
  ),
  "utf8",
).replace(/\s+/gu, " ");

describe("one-minute to four-hour Shorts source-duration migration", () => {
  it("widens every persisted duration constraint without rewriting history", () => {
    expect(migration).toMatch(
      /DROP CONSTRAINT IF EXISTS shorts_projects_duration_range, ADD CONSTRAINT shorts_projects_duration_range CHECK \( source_duration_seconds IS NULL OR source_duration_seconds BETWEEN 60 AND 14400 \)/i,
    );
    expect(migration).toMatch(
      /DROP CONSTRAINT IF EXISTS shorts_projects_requested_duration_range, ADD CONSTRAINT shorts_projects_requested_duration_range CHECK \( requested_source_duration_seconds IS NULL OR requested_source_duration_seconds BETWEEN 60 AND 14400 \)/i,
    );
    expect(migration).toMatch(
      /DROP CONSTRAINT IF EXISTS shorts_analysis_quota_reservations_source_duration_seconds_check, ADD CONSTRAINT shorts_analysis_quota_reservations_source_duration_seconds_check CHECK \(source_duration_seconds BETWEEN 60 AND 14400\)/i,
    );
  });

  it("updates all five active database guards while failing closed on schema drift", () => {
    for (const signature of [
      "public.shorts_submit_analysis_job(uuid,uuid,text,integer,text,boolean,uuid)",
      "public.shorts_complete_analysis_job(uuid,uuid,text,text,text,text,jsonb,integer,text,jsonb,jsonb)",
      "public.shorts_finalize_analysis_quota_reservation()",
      "public.shorts_submit_analysis_job_with_quota(uuid,uuid,text,integer,text,boolean,uuid,integer)",
      "public.shorts_adjust_analysis_quota(uuid,uuid,integer)",
    ]) {
      expect(migration).toContain(`'${signature}'::regprocedure`);
    }
    expect(migration).toContain("pg_catalog.pg_get_functiondef(v_signature)");
    expect(migration).toContain("1200 AND 7200");
    expect(migration).toContain("60 AND 14400");
  });

  it("uses supported pgTAP assertions to inspect persisted function bodies", () => {
    expect(databaseTest.match(/SELECT ok\(/gu)).toHaveLength(9);
    expect(
      databaseTest.match(/pg_catalog\.strpos\(.*?'1200 AND 7200'/gu),
    ).toHaveLength(5);
  });

  it("removes the legacy quota check that still rejects four-hour sources", () => {
    expect(quotaConstraintCleanup).toMatch(
      /DROP CONSTRAINT IF EXISTS shorts_analysis_quota_reservation_source_duration_seconds_check/i,
    );
    expect(databaseTest).toMatch(
      /NOT EXISTS \( SELECT 1 FROM pg_catalog\.pg_constraint WHERE conrelid = 'public\.shorts_analysis_quota_reservations'::regclass AND conname = 'shorts_analysis_quota_reservation_source_duration_seconds_check' \)/i,
    );
  });
});
