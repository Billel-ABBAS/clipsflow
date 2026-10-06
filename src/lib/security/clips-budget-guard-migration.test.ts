import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260929125203_clipsflow_monthly_render_budget_guard.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");
const serviceRoleGrantMigration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261005034254_clips_budget_guard_service_role_select.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("migration garde de budget ClipsFlow", () => {
  it("grants only the admin's required service-role read access", () => {
    expect(serviceRoleGrantMigration).toMatch(
      /REVOKE ALL ON TABLE public\.clips_budget_guard FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(serviceRoleGrantMigration).toMatch(
      /GRANT SELECT ON TABLE public\.clips_budget_guard TO service_role/i,
    );
  });

  it("est désactivée par défaut et isolée des rôles navigateur", () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.clips_budget_guard/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.clips_budget_guard ENABLE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.clips_budget_guard FORCE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.clips_budget_guard FROM PUBLIC/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.clips_budget_guard FROM anon, authenticated/i,
    );
    expect(migration).toMatch(/VALUES \(true, false, NULL\)/i);
  });

  it("garde la soumission atomique derrière le seul service_role", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.clips_submit_job[\s\S]*SECURITY DEFINER SET search_path = ''/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.clips_submit_job\([^)]+\) FROM PUBLIC/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.clips_submit_job\([^)]+\) FROM anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.clips_submit_job\([^)]+\) TO service_role/i,
    );
  });

  it("sérialise le plafond global et réserve les rendus non terminés", () => {
    expect(migration).toMatch(/pg_catalog\.pg_advisory_xact_lock/i);
    expect(migration).toMatch(/job\.status IN \('pending', 'processing'\)/i);
    expect(migration).toMatch(/estimated_cost_usd/i);
    expect(migration).toMatch(
      /v_completed_cost_usd \+ v_reserved_cost_usd \+ v_estimated_cost_usd/i,
    );
    expect(migration).toContain("'budget_exceeded'");
    expect(migration).toContain("'budget_unconfigured'");
  });
});
