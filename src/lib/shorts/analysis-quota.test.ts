import { describe, expect, it } from "vitest";

import { resolveShortsAnalysisQuotaSeconds } from "./analysis-quota";

describe("Shorts monthly analysis quota configuration", () => {
  it("uses the server-owned value for the resolved plan", () => {
    expect(
      resolveShortsAnalysisQuotaSeconds("pro", {
        SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_FREE: "0",
        SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_PRO: "21600",
      }),
    ).toBe(21_600);
  });

  it("allows zero to disable a plan without treating it as missing config", () => {
    expect(
      resolveShortsAnalysisQuotaSeconds("free", {
        SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_FREE: "0",
      }),
    ).toBe(0);
  });

  it.each([undefined, "", "  ", "-1", "1.5", "NaN", "9007199254740992"])(
    "fails closed for invalid or missing values (%s)",
    (value) => {
      expect(
        resolveShortsAnalysisQuotaSeconds("studio", {
          SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_STUDIO: value,
        }),
      ).toBeNull();
    },
  );
});
