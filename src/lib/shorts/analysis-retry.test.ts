import { describe, expect, it } from "vitest";

import { isTransientAnalysisUpstreamError } from "./analysis-retry";

describe("isTransientAnalysisUpstreamError", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])(
    "retries transient HTTP status %i",
    (status) => {
      expect(isTransientAnalysisUpstreamError({ status })).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 413])(
    "does not retry permanent HTTP status %i",
    (status) => {
      expect(isTransientAnalysisUpstreamError({ status })).toBe(false);
    },
  );

  it("recognizes provider connection and timeout errors", () => {
    expect(
      isTransientAnalysisUpstreamError({ name: "APIConnectionError" }),
    ).toBe(true);
    expect(
      isTransientAnalysisUpstreamError({ code: "UND_ERR_CONNECT_TIMEOUT" }),
    ).toBe(true);
    expect(
      isTransientAnalysisUpstreamError(new TypeError("fetch failed")),
    ).toBe(true);
    expect(isTransientAnalysisUpstreamError(new Error("invalid JSON"))).toBe(
      false,
    );
  });

  it("does not retry an exhausted provider quota even when reported as 429", () => {
    expect(
      isTransientAnalysisUpstreamError({
        status: 429,
        code: "insufficient_quota",
      }),
    ).toBe(false);
  });
});
