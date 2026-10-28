import { describe, expect, it } from "vitest";
import {
  filterShortsAnalysisCapabilities,
  isShortsAnalysisUserAllowed,
} from "./analysis-admission";

const user = "123e4567-e89b-42d3-a456-426614174000";
const other = "123e4567-e89b-42d3-a456-426614174001";

describe("controlled analysis admission", () => {
  it("preserves ordinary admission only when the restriction is absent", () => {
    expect(isShortsAnalysisUserAllowed(user, undefined)).toBe(true);
    expect(isShortsAnalysisUserAllowed(user, user.toUpperCase())).toBe(true);
    for (const invalid of ["", " ", "all", `${user},${other}`, "not-a-uuid"]) {
      expect(isShortsAnalysisUserAllowed(user, invalid)).toBe(false);
    }
    expect(isShortsAnalysisUserAllowed(other, user)).toBe(false);
  });

  it("hides analysis modes for other accounts without disabling independent features", () => {
    const capabilities = {
      audioAnalysis: true,
      videoAnalysis: true,
      creativeDirection: true,
      elevenLabs: true,
    };
    expect(filterShortsAnalysisCapabilities(capabilities, other, user)).toEqual(
      {
        audioAnalysis: false,
        videoAnalysis: false,
        creativeDirection: true,
        elevenLabs: true,
      },
    );
    expect(filterShortsAnalysisCapabilities(capabilities, user, user)).toEqual(
      capabilities,
    );
    expect(
      filterShortsAnalysisCapabilities(capabilities, user, undefined),
    ).toEqual(capabilities);
  });
});
