import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261003033837_clips_history_library_and_secure_shares.sql",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("migration historique et bibliothèque privée des clips", () => {
  it("lie collections, clips et partages à leur propriétaire", () => {
    expect(migration).toMatch(
      /UNIQUE \(id, user_id\)[\s\S]*?FOREIGN KEY \(collection_id, user_id\)[\s\S]*?REFERENCES public\.clip_collections\(id, user_id\)/i,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(clip_id, user_id\)[\s\S]*?REFERENCES public\.clips\(id, user_id\) ON DELETE CASCADE/i,
    );
    expect(migration).toMatch(
      /CREATE TABLE public\.clip_share_links[\s\S]*?FOREIGN KEY \(clip_id, user_id\)[\s\S]*?REFERENCES public\.clips\(id, user_id\) ON DELETE CASCADE/i,
    );
  });

  it("force RLS et réserve les tables privées à service_role", () => {
    for (const table of [
      "clip_collections",
      "clip_collection_items",
      "clip_share_links",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\\.${table} TO service_role`,
          "i",
        ),
      );
    }
  });

  it("stocke uniquement le hash des liens et permet leur révocation", () => {
    expect(migration).toMatch(/token_hash text NOT NULL UNIQUE/i);
    expect(migration).toMatch(/token_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
    expect(migration).toMatch(/revoked_at timestamptz/i);
    expect(migration).not.toMatch(
      /CREATE TABLE public\.clip_share_links[^;]*\btoken text\b/i,
    );
  });

  it("verrouille les soumissions, reprises et mutations de collections", () => {
    for (const functionName of [
      "clips_submit_job_idempotent",
      "clips_retry_failed_job",
      "clips_set_collection",
    ]) {
      expect(migration).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([^)]+\\) FROM PUBLIC, anon, authenticated`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([^)]+\\) TO service_role`,
          "i",
        ),
      );
    }
    expect(migration.match(/pg_catalog\.pg_advisory_xact_lock/g)).toHaveLength(
      3,
    );
    expect(migration).toMatch(/idempotency_conflict/i);
    expect(migration).toMatch(/retry_request_ids/i);
  });
});
