import { describe, expect, it } from "vitest";

import { resolveShortsAnalysisWorkerRunMode } from "./analysis-worker-run-mode";

describe("resolveShortsAnalysisWorkerRunMode", () => {
  it("keeps a worker disabled unless its processing flag is explicitly enabled", () => {
    expect(resolveShortsAnalysisWorkerRunMode({})).toBe("disabled");
    expect(
      resolveShortsAnalysisWorkerRunMode({
        SHORTS_ANALYSIS_WORKER_ENABLED: "false",
      }),
    ).toBe("disabled");
  });

  it("accepts only the documented processing enablement values", () => {
    expect(
      resolveShortsAnalysisWorkerRunMode({
        SHORTS_ANALYSIS_WORKER_ENABLED: "true",
      }),
    ).toBe("process-one");
    expect(
      resolveShortsAnalysisWorkerRunMode({
        SHORTS_ANALYSIS_WORKER_ENABLED: "1",
      }),
    ).toBe("process-one");
  });

  it("lets verify-only run while processing is disabled", () => {
    expect(
      resolveShortsAnalysisWorkerRunMode({
        SHORTS_ANALYSIS_WORKER_ENABLED: "false",
        SHORTS_ANALYSIS_WORKER_VERIFY_ONLY: "true",
      }),
    ).toBe("verify-only");
  });

  it("makes verify-only take precedence over a processing-enabled worker", () => {
    expect(
      resolveShortsAnalysisWorkerRunMode({
        SHORTS_ANALYSIS_WORKER_ENABLED: "true",
        SHORTS_ANALYSIS_WORKER_VERIFY_ONLY: "1",
      }),
    ).toBe("verify-only");
  });
});
