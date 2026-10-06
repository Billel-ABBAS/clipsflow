import { describe, expect, it } from "vitest";
import { shouldReduceShortsMotion } from "./motion-preferences";

describe("shouldReduceShortsMotion", () => {
  it("keeps the legacy animated rendering when no Shorts profile exists", () => {
    expect(shouldReduceShortsMotion()).toBe(false);
    expect(shouldReduceShortsMotion(false, "editorial-focus")).toBe(false);
  });

  it("disables decorative motion when the accessibility preference is set", () => {
    expect(shouldReduceShortsMotion(true, "kinetic-captions")).toBe(true);
  });

  it("treats the minimal-static template as a static rendering preference", () => {
    expect(shouldReduceShortsMotion(false, "minimal-static")).toBe(true);
  });
});
