import { describe, expect, it } from "vitest";

import {
  buildProductionProfile,
  formatShortsTimestamp,
  isShortsAnalysisUnavailable,
  isShortsRenderDisabled,
  isShortsSelectionSaveDisabled,
  isValidShortsSourceDuration,
  normaliseShortsProject,
  resolveShortsCandidatePage,
  resolveShortsAnalysisErrorCopyKey,
  SHORTS_MAX_SOURCE_DURATION_SECONDS,
  SHORTS_MIN_SOURCE_DURATION_SECONDS,
} from "./ShortsStudio";

describe("ShortsStudio pure boundaries", () => {
  it("makes every candidate reachable while keeping three cards per page", () => {
    const visibleIndices = Array.from({ length: 8 }, (_, page) => {
      const range = resolveShortsCandidatePage(24, page * 3);
      expect(range.pageIndex).toBe(page);
      expect(range.pageCount).toBe(8);
      return Array.from(
        { length: range.end - range.start },
        (_, index) => range.start + index,
      );
    }).flat();
    expect(visibleIndices).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    );
    expect(resolveShortsCandidatePage(4, 3)).toMatchObject({
      start: 3,
      end: 4,
    });
    expect(resolveShortsCandidatePage(0, -1)).toMatchObject({
      start: 0,
      end: 0,
      pageCount: 0,
    });
  });
  it("accepts the inclusive one-minute to four-hour source contract", () => {
    expect(
      isValidShortsSourceDuration(SHORTS_MIN_SOURCE_DURATION_SECONDS),
    ).toBe(true);
    expect(
      isValidShortsSourceDuration(SHORTS_MAX_SOURCE_DURATION_SECONDS),
    ).toBe(true);
    expect(
      isValidShortsSourceDuration(SHORTS_MIN_SOURCE_DURATION_SECONDS - 1),
    ).toBe(false);
    expect(
      isValidShortsSourceDuration(SHORTS_MAX_SOURCE_DURATION_SECONDS + 1),
    ).toBe(false);
    expect(isValidShortsSourceDuration(60.5)).toBe(false);
  });

  it("surfaces server availability failures separately from source errors", () => {
    expect(
      isShortsAnalysisUnavailable(503, "analysis_temporarily_unavailable"),
    ).toBe(true);
    expect(isShortsAnalysisUnavailable(503, null)).toBe(true);
    expect(isShortsAnalysisUnavailable(400, "episode_not_found")).toBe(false);
  });

  it("explains an unconfigured plan quota instead of suggesting a transient retry", () => {
    expect(
      resolveShortsAnalysisErrorCopyKey(503, "analysis_quota_unconfigured"),
    ).toBe("analysisQuotaUnconfigured");
    expect(
      resolveShortsAnalysisErrorCopyKey(402, "analysis_quota_exceeded"),
    ).toBe("analysisQuotaExceeded");
    expect(
      resolveShortsAnalysisErrorCopyKey(
        503,
        "analysis_temporarily_unavailable",
      ),
    ).toBe("analysisUnavailable");
    expect(resolveShortsAnalysisErrorCopyKey(400, "episode_not_found")).toBe(
      "projectError",
    );
  });

  it("formats timestamps without a time-zone-dependent Date conversion", () => {
    expect(formatShortsTimestamp(0)).toBe("00:00");
    expect(formatShortsTimestamp(65)).toBe("01:05");
    expect(formatShortsTimestamp(3_661)).toBe("01:01:01");
    expect(formatShortsTimestamp(-1)).toBe("—");
  });

  it("drops malformed and duplicate candidates from an untrusted project response", () => {
    const project = normaliseShortsProject({
      data: {
        id: "project-1",
        status: "ready",
        candidates: [
          {
            id: "candidate-2",
            rank: 2,
            start_seconds: 90,
            end_seconds: 150,
            score: 81,
            title: "Second",
            hook: "A useful hook",
            rationale: "A grounded rationale",
            transcript_excerpt: "Transcript text",
            music_mood: "focused",
            motion_direction: "Keep the captions calm and clear.",
          },
          {
            id: "candidate-1",
            rank: 1,
            start_seconds: 0,
            end_seconds: 60,
            score: 92,
            title: "First",
            hook: "A stronger hook",
            rationale: "A grounded rationale",
            transcript_excerpt: "Transcript text",
            music_mood: "energetic",
            motion_direction: "Emphasize the opening phrase once.",
          },
          {
            id: "candidate-1",
            rank: 3,
            start_seconds: 160,
            end_seconds: 220,
            score: 70,
            title: "Duplicate",
            hook: "Duplicate hook",
            rationale: "Duplicate rationale",
            transcript_excerpt: "Transcript text",
            music_mood: "warm",
            motion_direction: "Use restrained emphasis.",
          },
          { id: "malformed" },
        ],
      },
    });

    expect(project?.candidates.map((candidate) => candidate.id)).toEqual([
      "candidate-1",
      "candidate-2",
    ]);
    expect(project?.candidates[0]).toMatchObject({
      musicMood: "energetic",
      motionDirection: "Emphasize the opening phrase once.",
    });
  });

  it("exposes only the safe monthly-quota failure flag to the interface", () => {
    expect(
      normaliseShortsProject({
        id: "project-1",
        status: "failed",
        analysis_quota_exceeded: true,
        candidates: [],
      }),
    ).toMatchObject({
      status: "failed",
      analysisQuotaExceeded: true,
    });
    expect(
      normaliseShortsProject({
        id: "project-2",
        status: "failed",
        error_message: "sensitive-internal-detail",
        candidates: [],
      }),
    ).toMatchObject({ analysisQuotaExceeded: false });
  });

  it("requires both explicit consent and commercial-license confirmation before enabling ElevenLabs", () => {
    const noAuthorization = buildProductionProfile({
      aspectRatio: "9:16",
      subtitleStyle: "viral",
      motionTemplate: "punchy-cuts",
      reducedMotion: false,
      elevenLabsEnabled: true,
      elevenLabsAvailable: true,
      elevenLabsConsent: true,
      commercialLicenseConfirmed: false,
      creativeDirectionEnabled: false,
      creativeDirectionAvailable: true,
      creativeDirectionConsent: false,
    });
    expect(noAuthorization.elevenlabs.enabled).toBe(false);
    expect(noAuthorization.elevenlabs.synthetic_voice).toBe(false);
    expect(noAuthorization.elevenlabs.use_cases).toEqual([]);

    const authorized = buildProductionProfile({
      aspectRatio: "9:16",
      subtitleStyle: "viral",
      motionTemplate: "punchy-cuts",
      reducedMotion: true,
      elevenLabsEnabled: true,
      elevenLabsAvailable: true,
      elevenLabsConsent: true,
      commercialLicenseConfirmed: true,
      creativeDirectionEnabled: false,
      creativeDirectionAvailable: true,
      creativeDirectionConsent: false,
    });
    expect(authorized.elevenlabs.enabled).toBe(true);
    expect(authorized.elevenlabs.use_cases).toEqual([
      "instrumental_music",
      "sound_effects",
    ]);
    expect(authorized.motion.template).toBe("minimal-static");
    expect(authorized.motion.renderer).toBe("deterministic");
    expect(authorized.creative_direction.enabled).toBe(false);

    const opusAuthorized = buildProductionProfile({
      aspectRatio: "9:16",
      subtitleStyle: "viral",
      motionTemplate: "punchy-cuts",
      reducedMotion: false,
      elevenLabsEnabled: true,
      elevenLabsAvailable: true,
      elevenLabsConsent: true,
      commercialLicenseConfirmed: true,
      creativeDirectionEnabled: true,
      creativeDirectionAvailable: true,
      creativeDirectionConsent: true,
    });
    expect(opusAuthorized.creative_direction).toEqual({
      enabled: true,
      explicit_consent: true,
    });

    const unavailable = buildProductionProfile({
      aspectRatio: "9:16",
      subtitleStyle: "viral",
      motionTemplate: "punchy-cuts",
      reducedMotion: false,
      elevenLabsEnabled: true,
      elevenLabsAvailable: false,
      elevenLabsConsent: true,
      commercialLicenseConfirmed: true,
      creativeDirectionEnabled: true,
      creativeDirectionAvailable: false,
      creativeDirectionConsent: true,
    });
    expect(unavailable.elevenlabs.enabled).toBe(false);
    expect(unavailable.creative_direction).toEqual({
      enabled: false,
      explicit_consent: false,
    });
  });

  it("keeps render disabled until candidates and adapted music are authorized", () => {
    const ready = {
      candidatesReady: true,
      selectedCandidateCount: 2,
      adaptedMusicAuthorized: true,
      savingSelection: false,
      renderingSelected: false,
    };

    expect(isShortsRenderDisabled(ready)).toBe(false);
    expect(
      isShortsRenderDisabled({ ...ready, adaptedMusicAuthorized: false }),
    ).toBe(true);
    expect(
      isShortsRenderDisabled({ ...ready, selectedCandidateCount: 0 }),
    ).toBe(true);
  });

  it("allows saving selected moments without paid music authorization", () => {
    const ready = {
      candidatesReady: true,
      selectedCandidateCount: 2,
      savingSelection: false,
      renderingSelected: false,
    };

    expect(isShortsSelectionSaveDisabled(ready)).toBe(false);
    expect(
      isShortsSelectionSaveDisabled({ ...ready, selectedCandidateCount: 0 }),
    ).toBe(true);
    expect(
      isShortsSelectionSaveDisabled({ ...ready, savingSelection: true }),
    ).toBe(true);
  });
});
