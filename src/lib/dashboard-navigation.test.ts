import { describe, expect, it } from "vitest";

import { isDashboardNavigationActive } from "./dashboard-navigation";

describe("isDashboardNavigationActive", () => {
  it("marks the exact route as active", () => {
    expect(isDashboardNavigationActive("/dashboard", "/dashboard")).toBe(true);
    expect(isDashboardNavigationActive("/clips", "/clips")).toBe(true);
  });

  it("normalizes a trailing slash", () => {
    expect(isDashboardNavigationActive("/clips/new/", "/clips/new")).toBe(true);
  });

  it("does not mark a parent route active for a different workflow", () => {
    expect(isDashboardNavigationActive("/clips/new", "/clips")).toBe(false);
  });
});
