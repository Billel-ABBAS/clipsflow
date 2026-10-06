import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/20261004104751_shorts_large_source_uploads.sql";
const migration = readFileSync(
  join(process.cwd(), migrationPath),
  "utf8",
).replace(/\s+/gu, " ");
const supabaseConfig = readFileSync(
  join(process.cwd(), "supabase/config.toml"),
  "utf8",
);

describe("Shorts large-source upload migration", () => {
  it("raises only the private source bucket limit to the application cap", () => {
    expect(migration).toMatch(
      /UPDATE storage\.buckets SET file_size_limit = 8589934592 WHERE id = 'clip-sources'/iu,
    );
    expect(migration).toMatch(/global Storage limit/iu);
    expect(migration).toMatch(/at least\s+(?:--\s*)?8 GiB/iu);
    expect(migration).not.toMatch(/SET public\s*=\s*true/iu);
  });

  it("keeps the local global Storage cap at least as high as the source bucket", () => {
    const storageSection = supabaseConfig
      .split(/^\[storage\]\r?\n/mu)[1]
      ?.split(/^\[/mu)[0];
    expect(storageSection).toMatch(/^file_size_limit\s*=\s*"8GiB"\s*$/mu);
  });
});
