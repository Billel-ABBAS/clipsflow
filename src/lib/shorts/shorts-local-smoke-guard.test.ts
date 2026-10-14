import { expect, it } from "vitest";

import {
  analysisQueueCountSql,
  assertAnalysisQueueEmptyCount,
} from "../../../scripts/shorts-analysis-queue-guard.mjs";

it("refuses an existing pending job with a read-only count", () => {
  expect(analysisQueueCountSql).toContain("pending");
  expect(() => assertAnalysisQueueEmptyCount("1")).toThrow();
});
