import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261004150000_youtube_publication_queue.sql",
  ),
  "utf8",
).replace(/\s+/gu, " ");

describe("YouTube publication queue migration", () => {
  it("keeps tokens nullable only to support explicit local disconnect", () => {
    expect(migration).toMatch(
      /ALTER COLUMN refresh_token_ciphertext DROP NOT NULL/iu,
    );
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS error_code text/iu);
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS upload_session_uri_ciphertext text/iu,
    );
    expect(migration).toMatch(/CHECK \(attempt_count BETWEEN 0 AND 5\)/iu);
  });

  it("claims only confirmed jobs with a fenced, expiring lease", () => {
    expect(migration).toMatch(
      /shorts_claim_youtube_publication[\s\S]*?confirmed_at IS NOT NULL[\s\S]*?FOR UPDATE SKIP LOCKED[\s\S]*?worker_lease_token = gen_random_uuid\(\)/iu,
    );
    expect(migration).toMatch(
      /shorts_renew_youtube_publication_lease[\s\S]*?worker_lease_token = p_lease_token[\s\S]*?worker_lease_expires_at > v_now/iu,
    );
  });

  it("restricts every security-definer queue RPC to service_role", () => {
    for (const functionName of [
      "shorts_claim_youtube_publication",
      "shorts_renew_youtube_publication_lease",
      "shorts_save_youtube_upload_progress",
      "shorts_complete_youtube_publication",
      "shorts_fail_youtube_publication",
    ]) {
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${functionName}\\(`, "iu"),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\(`,
          "iu",
        ),
      );
    }
    expect(migration).toMatch(/SET search_path = pg_catalog, public/iu);
  });
});
