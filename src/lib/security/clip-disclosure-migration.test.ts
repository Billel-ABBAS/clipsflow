import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260930051509_clip_disclosure_events.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("migration audit disclosure IA", () => {
  it("is idempotent, minimal, and bound to one rendered clip", () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.ai_disclosure_events/i,
    );
    expect(migration).toMatch(
      /REFERENCES public\.clips \(id\) ON DELETE CASCADE/i,
    );
    expect(migration).toMatch(
      /UNIQUE \(clip_id, surface, disclosure_version\)/i,
    );
    expect(migration).toMatch(/surface IN \('clip_subtitle'\)/i);
  });

  it("is inaccessible to browser roles and explicitly service-role only", () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.ai_disclosure_events ENABLE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.ai_disclosure_events FORCE ROW LEVEL SECURITY/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.ai_disclosure_events FROM PUBLIC/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.ai_disclosure_events FROM anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.ai_disclosure_events TO service_role/i,
    );
  });
});
