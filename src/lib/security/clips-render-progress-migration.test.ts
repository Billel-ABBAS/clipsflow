import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261003134203_clips_render_progress_stage.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("migration de progression des rendus", () => {
  it("persists only a bounded finalization stage tied to a render attempt", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS render_stage text/i);
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS render_stage_attempt_count integer/i,
    );
    expect(migration).toMatch(/render_stage = 'completing'/i);
    expect(migration).toMatch(
      /render_stage_attempt_count = job\.attempt_count/i,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER jobs_clear_render_progress_stage[\s\S]*?BEFORE UPDATE OF status, attempt_count ON public\.jobs/i,
    );
    expect(migration).toMatch(
      /NEW\.render_stage := NULL[\s\S]*?NEW\.render_stage_attempt_count := NULL/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.clips_clear_render_progress_stage\(\) FROM PUBLIC/i,
    );
  });

  it("fences the transition by active lease and grants it only to service_role", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.clips_mark_render_completing/i,
    );
    expect(migration).toMatch(/SECURITY DEFINER SET search_path = ''/i);
    expect(migration).toMatch(/job\.type = 'render'/i);
    expect(migration).toMatch(/job\.status = 'processing'/i);
    expect(migration).toMatch(/job\.lease_token = p_lease_token/i);
    expect(migration).toMatch(/job\.lease_expires_at > v_now/i);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.clips_mark_render_completing\(uuid, uuid\) FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.clips_mark_render_completing\(uuid, uuid\) TO service_role/i,
    );
  });
});
