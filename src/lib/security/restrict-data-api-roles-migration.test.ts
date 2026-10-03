import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260928203332_restrict_data_api_roles.sql",
);

describe("restricted Data API role migration", () => {
  const migration = readFileSync(migrationPath, "utf8");

  it("revokes inherited table privileges before granting the browser surface", () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE[\s\S]+FROM anon, authenticated;/i,
    );
    expect(migration).toMatch(/GRANT SELECT ON TABLE[\s\S]+TO authenticated;/i);
    expect(migration).toMatch(
      /GRANT UPDATE \(email, full_name, locale\)[\s\S]+TO authenticated;/i,
    );
  });

  it("keeps lifecycle writes server-only and narrows RLS policies", () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE[\s\S]+TO service_role;/i,
    );
    expect(migration).toContain(
      'ALTER POLICY "profiles_select_own" ON public.profiles TO authenticated;',
    );
    expect(migration).toContain(
      'ALTER POLICY "episodes_select_own" ON public.episodes TO authenticated;',
    );
    expect(migration).toContain(
      'ALTER POLICY "clips_select_own" ON public.clips TO authenticated;',
    );
    expect(migration).toContain(
      'ALTER POLICY "jobs_select_own" ON public.jobs TO authenticated;',
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "episodes_delete_own" ON public.episodes;',
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "clips_delete_own" ON public.clips;',
    );
  });
});
