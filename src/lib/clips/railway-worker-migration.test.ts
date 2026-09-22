import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260922153033_railway_render_worker_leases.sql",
  ),
  "utf8",
);

describe("Railway worker database contract", () => {
  it("uses fenced leases and service-role-only atomic functions", () => {
    for (const functionName of [
      "clips_claim_render_job(integer)",
      "clips_renew_render_lease(uuid, uuid, integer)",
      "clips_complete_render_job(uuid, uuid, text, text, text, text, numeric, smallint, text)",
      "clips_fail_render_job(uuid, uuid, text)",
    ]) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.${functionName} FROM PUBLIC;`,
      );
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${functionName} TO service_role;`,
      );
    }
    expect(migration).toContain("lease_token uuid");
    expect(migration).toContain("lease_expires_at timestamptz");
    expect(migration).toContain("refund_applied_at timestamptz");
    expect(migration.match(/SET search_path = ''/g)).toHaveLength(4);
  });
});
