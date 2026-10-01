import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260929125822_clipsflow_rls_query_plan_indexes.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("migration RLS query plan et index jobs", () => {
  it("conserve les cinq policies ciblées avec auth.uid évalué une fois", () => {
    for (const [table, policy, column] of [
      ["profiles", "profiles_select_own", "id"],
      ["profiles", "profiles_update_own_nonsensitive", "id"],
      ["episodes", "episodes_select_own", "user_id"],
      ["clips", "clips_select_own", "user_id"],
      ["jobs", "jobs_select_own", "user_id"],
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER POLICY "${policy}" ON public\\.${table} USING \\(\\(SELECT auth\\.uid\\(\\)\\) = ${column}\\)`,
          "i",
        ),
      );
    }
  });

  it("couvre les deux relations jobs appelées par les suppressions et jointures", () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_jobs_clip_id/i);
    expect(migration).toMatch(/ON public\.jobs \(clip_id\)/i);
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_jobs_episode_id/i,
    );
    expect(migration).toMatch(/ON public\.jobs \(episode_id\)/i);
  });
});
