import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261024182118_per_short_production_profiles.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("per-Short production profile migration", () => {
  const functionName = "shorts_set_selected_candidate_profiles";

  it("accepts only a bounded unique profile list for one ready owned project", () => {
    expect(migration).toMatch(
      new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${functionName}\\( p_user_id uuid, p_project_id uuid, p_candidate_profiles jsonb \\)`,
        "i",
      ),
    );
    expect(migration).toMatch(
      /jsonb_array_length\(p_candidate_profiles\) < 1/i,
    );
    expect(migration).toMatch(
      /jsonb_array_length\(p_candidate_profiles\) > 12/i,
    );
    expect(migration).toMatch(
      /count\(DISTINCT selection\.value ->> 'candidate_id'\)/i,
    );
    expect(migration).toMatch(/candidate_id'\) !~\* '\^\[0-9a-f\]/i);
    expect(migration).toMatch(
      /project\.user_id = p_user_id[\s\S]*?project\.status = 'ready'[\s\S]*?FOR UPDATE/i,
    );
    expect(migration).toMatch(/candidate_not_in_project/i);
  });

  it("atomically replaces selected candidates without exposing the RPC to clients", () => {
    expect(migration).toMatch(
      /UPDATE public\.shorts_candidates AS candidate SET selected = false, updated_at = now\(\)/i,
    );
    expect(migration).toMatch(
      /SET selected = true, production_profile = requested\.production_profile, updated_at = now\(\)/i,
    );
    expect(migration).toMatch(
      new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${functionName}\\(uuid, uuid, jsonb\\) FROM PUBLIC, anon, authenticated`,
        "i",
      ),
    );
    expect(migration).toMatch(
      new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\(uuid, uuid, jsonb\\) TO service_role`,
        "i",
      ),
    );
    expect(migration).toMatch(/SECURITY DEFINER[\s\S]*?SET search_path = ''/i);
  });
});
