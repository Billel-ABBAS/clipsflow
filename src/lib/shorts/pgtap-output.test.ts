import { describe, expect, it } from "vitest";

import { assertTapOutput } from "./pgtap-output.mjs";

describe("assertTapOutput", () => {
  it("accepts a complete passing TAP plan", () => {
    expect(
      assertTapOutput("1..2\nok 1 - first\nok 2 - second", "suite.sql"),
    ).toEqual({ assertions: 2 });
  });

  it("rejects a failing pgTAP assertion even when psql exits successfully", () => {
    expect(() =>
      assertTapOutput("1..2\nok 1 - first\nnot ok 2 - regression", "suite.sql"),
    ).toThrow("suite.sql: pgTAP failed assertion(s): 2");
  });

  it("rejects an incomplete plan", () => {
    expect(() => assertTapOutput("1..2\nok 1 - first", "suite.sql")).toThrow(
      "planned 2 assertions but emitted 1",
    );
  });

  it("rejects missing, duplicate, or empty plans", () => {
    for (const output of ["ok 1 - no plan", "1..1\n1..1\nok 1", "1..0"]) {
      expect(() => assertTapOutput(output, "suite.sql")).toThrow(
        "expected exactly one non-empty pgTAP plan",
      );
    }
  });

  it("rejects a bail out and out-of-order assertion numbering", () => {
    expect(() =>
      assertTapOutput("Bail out! setup failed", "suite.sql"),
    ).toThrow("pgTAP bailed out");
    expect(() =>
      assertTapOutput("1..2\nok 2 - second\nok 1 - first", "suite.sql"),
    ).toThrow("assertion numbering is incomplete");
  });
});
