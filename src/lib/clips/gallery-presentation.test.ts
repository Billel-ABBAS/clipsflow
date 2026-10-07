import { describe, expect, it } from "vitest";

import {
  getGalleryCardSelectionClassName,
  getGalleryScoreClassName,
  getGalleryStatusClassName,
} from "./gallery-presentation";

describe("gallery presentation", () => {
  it.each([
    ["pending", "text-muted-foreground"],
    ["processing", "text-cyan-200"],
    ["completing", "text-[#b5a7ff]"],
    ["completed", "text-[#36f0cf]"],
    ["failed", "text-destructive"],
  ] as const)("uses the ClipsFlow status accent for %s", (status, accent) => {
    expect(getGalleryStatusClassName(status)).toContain(accent);
  });

  it.each([
    [80, "text-[#36f0cf]"],
    [50, "text-amber-200"],
    [49, "text-destructive"],
  ] as const)(
    "assigns score %i to the matching contrast-safe tone",
    (score, tone) => {
      expect(getGalleryScoreClassName(score)).toContain(tone);
    },
  );

  it("gives selected download cards a clear violet outline", () => {
    expect(getGalleryCardSelectionClassName(true)).toContain("ring-primary");
    expect(getGalleryCardSelectionClassName(false)).toBe("");
  });
});
