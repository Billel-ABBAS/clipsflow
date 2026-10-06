// ============================================================================
// ClipsFlow Shorts — pure production-instruction mapper
// ============================================================================
// Converts an already selected short and bounded analysis metadata into a
// deterministic production brief. This module deliberately does not fetch a
// music catalog, generate audio, inspect frames, or render media. Callers use
// the returned typed instructions as input to their separately authorised
// workers.
// ============================================================================

import type { AspectRatio, StyleKey } from "./types";

export const MAX_SHORT_DURATION_SECONDS = 180;

/** ElevenLabs' API bounds for a requested text-to-sound effect. */
export const ELEVENLABS_SFX_DURATION_BOUNDS_SECONDS = {
  min: 0.5,
  max: 30,
} as const;

/** Product cap for a single accent effect inside a short. */
export const MAX_SHORT_SFX_DURATION_SECONDS = 3;

/** ElevenLabs Music API bounds for a prompted `music_v2_5` composition. */
export const ELEVENLABS_MUSIC_DURATION_BOUNDS_MS = {
  min: 3_000,
  max: 600_000,
} as const;

export const CATALOG_THEMES = [
  "business",
  "education",
  "technology",
  "health",
  "finance",
  "gaming",
  "podcast",
  "interview",
  "lifestyle",
  "sports",
  "news",
  "entertainment",
] as const;

export type CatalogTheme = (typeof CATALOG_THEMES)[number];
export type SourceMediaKind = "audio" | "video";
export type ContentTone =
  | "educational"
  | "entertaining"
  | "inspirational"
  | "reflective"
  | "neutral";
export type ContentPace = "slow" | "conversational" | "fast";
export type MusicMood =
  | "focused"
  | "playful"
  | "uplifting"
  | "warm"
  | "energetic"
  | "minimal";
export type MusicEnergy = "low" | "medium" | "high";
export type ElevenLabsSoundDesignExecution =
  | "blocked-pending-consent"
  | "ready-for-authorized-worker";
export type MotionTemplate =
  | "punchy-cuts"
  | "kinetic-captions"
  | "editorial-focus"
  | "calm-focus"
  | "audiogram-waveform"
  | "minimal-static";
export type SubtitleEmphasisLevel = "light" | "balanced" | "high-impact";

export interface SelectedShortMetadata {
  /** Absolute source-media timestamp, in seconds. */
  startSeconds: number;
  /** Absolute source-media timestamp, in seconds. */
  endSeconds: number;
  aspectRatio: AspectRatio;
  styleKey: StyleKey;
  sourceKind: SourceMediaKind;
  /** Used only as a conservative signal that speech is present. Never emitted. */
  transcript?: string | null;
}

export interface ShortAnalysisMetadata {
  /** Existing 0-100 hook score. Out-of-range values are clamped. */
  hookScore?: number | null;
  tone?: ContentTone | null;
  pace?: ContentPace | null;
  /** Fraction of the selected short containing speech, from 0 to 1. */
  speechCoverage?: number | null;
  /** Untrusted labels are reduced to the catalog's small allow-list. */
  themes?: readonly string[] | null;
  /** Requests only a bounded, consent-gated visual-analysis job shape. */
  requestVisualAnalysis?: boolean | null;
  /** Opts the selected short into an ElevenLabs sound-design plan. */
  requestElevenLabsSoundDesign?: boolean | null;
}

export interface SoundDesignAuthorization {
  /** Consent is checked again by any worker before an external request. */
  explicitUserConsent: boolean;
  /** The account holder confirms a commercial-use license is in place. */
  commercialLicenseConfirmed: boolean;
}

export interface ShortsProductionInput {
  selectedShort: SelectedShortMetadata;
  analysis: ShortAnalysisMetadata;
  /** Ensures the returned brief never selects animated motion when true. */
  reducedMotion?: boolean;
  /** Optional authorisation metadata for a separately authorised audio worker. */
  soundDesignAuthorization?: Partial<SoundDesignAuthorization> | null;
}

export interface LicensedCatalogQueryConstraints {
  source: "licensed-catalog-only";
  musicGeneration: "never";
  requiredLicense: "commercial-social-sync";
  instrumentalOnly: true;
  excludeExplicitContent: true;
  targetBpm: { min: number; max: number };
  moods: readonly MusicMood[];
  themes: readonly CatalogTheme[];
  maxTrackDurationSeconds: number;
}

export interface MusicRecommendation {
  action: "recommend-only";
  generated: false;
  mood: MusicMood;
  energy: MusicEnergy;
  catalogQuery: LicensedCatalogQueryConstraints;
}

export interface ElevenLabsShortSfxPlan {
  modelId: "eleven_text_to_sound_v2";
  maximumEffects: 2;
  providerDurationBoundsSeconds: typeof ELEVENLABS_SFX_DURATION_BOUNDS_SECONDS;
  productionDurationBoundsSeconds: {
    min: typeof ELEVENLABS_SFX_DURATION_BOUNDS_SECONDS.min;
    max: number;
  };
  requestedDurationSeconds: number;
  loop: false;
  spokenContent: "prohibited";
}

export interface ElevenLabsBackgroundMusicPlan {
  modelId: "music_v2_5";
  providerDurationBoundsMs: typeof ELEVENLABS_MUSIC_DURATION_BOUNDS_MS;
  requestedDurationMs: number;
  instrumentalOnly: true;
  vocalContent: "prohibited";
}

export interface ElevenLabsSoundDesignPlan {
  provider: "elevenlabs";
  execution: ElevenLabsSoundDesignExecution;
  action: "plan-only";
  authorization: {
    requiresExplicitUserConsent: true;
    explicitUserConsent: boolean;
    commercialLicenseRequired: true;
    commercialLicenseConfirmed: boolean;
  };
  /** Sound effects and music only. The plan never creates a synthetic voice. */
  syntheticVoice: "prohibited";
  shortSfx: ElevenLabsShortSfxPlan | null;
  backgroundMusic: ElevenLabsBackgroundMusicPlan | null;
  voiceDucking: VoiceDuckingInstruction;
}

export interface ClaudeCreativeDirectorPlan {
  provider: "anthropic";
  model: "Claude Opus 5.5";
  availability: "waiting-for-official-api-model-id";
  action: "creative-direction-plan-only";
  scope: "selected-short-only";
  candidatePolicy: "final-selection-only";
  expectedOutputs: readonly (
    | "motion-beat-sheet"
    | "subtitle-emphasis-refinement"
    | "sound-placement-guidance"
  )[];
}

export interface VoiceDuckingInstruction {
  enabled: boolean;
  /** Negative gain applied to a chosen music track while speech is present. */
  musicGainDuringSpeechDb: number | null;
  attackMs: number | null;
  releaseMs: number | null;
}

export interface MotionInstruction {
  template: MotionTemplate;
  reducedMotion: boolean;
  maxCutsPerMinute: number;
  captionAnimation: "none" | "subtle" | "energetic";
}

export interface SubtitleEmphasisProfile {
  level: SubtitleEmphasisLevel;
  autoEmphasis: boolean;
  maxEmphasizedWordsPerCue: number;
  triggers: readonly ("numbers" | "power-words" | "calls-to-action")[];
  animation: "none" | "subtle" | "pop";
}

export interface VisualAnalysisRequest {
  kind: "selected-short-visual-analysis";
  requiresExplicitUserConsent: true;
  sourceScope: "selected-short-only";
  startSeconds: number;
  endSeconds: number;
  sampleRateFps: 1;
  outputs: readonly ("shot-boundaries" | "subject-framing" | "motion-level")[];
  includeAudio: false;
  faceRecognition: "disabled";
  retainFrames: false;
  externalTransfer: "disabled";
}

export interface ShortsProductionInstructions {
  selectedShort: {
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    aspectRatio: AspectRatio;
    sourceKind: SourceMediaKind;
  };
  music: MusicRecommendation;
  /** Optional sound-design plan; a separate authorised worker owns execution. */
  elevenLabsSoundDesign: ElevenLabsSoundDesignPlan | null;
  voiceDucking: VoiceDuckingInstruction;
  motion: MotionInstruction;
  subtitles: SubtitleEmphasisProfile;
  visualAnalysis: VisualAnalysisRequest | null;
  /** This brief is scoped to the selected short, never the candidate set. */
  creativeDirector: ClaudeCreativeDirectorPlan;
}

const CATALOG_THEME_SET = new Set<string>(CATALOG_THEMES);

const BPM_BY_MOOD: Record<MusicMood, readonly [number, number]> = {
  focused: [82, 106],
  playful: [100, 124],
  uplifting: [96, 122],
  warm: [72, 96],
  energetic: [118, 142],
  minimal: [76, 102],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function validTone(value: ContentTone | null | undefined): ContentTone {
  switch (value) {
    case "educational":
    case "entertaining":
    case "inspirational":
    case "reflective":
    case "neutral":
      return value;
    default:
      return "neutral";
  }
}

function validPace(value: ContentPace | null | undefined): ContentPace {
  switch (value) {
    case "slow":
    case "conversational":
    case "fast":
      return value;
    default:
      return "conversational";
  }
}

function musicMood(
  tone: ContentTone,
  pace: ContentPace,
  hookScore: number,
): MusicMood {
  switch (tone) {
    case "educational":
      return "focused";
    case "entertaining":
      return pace === "slow" ? "playful" : "energetic";
    case "inspirational":
      return "uplifting";
    case "reflective":
      return "warm";
    case "neutral":
      return pace === "fast" || hookScore >= 80 ? "energetic" : "minimal";
  }
}

function musicEnergy(pace: ContentPace, hookScore: number): MusicEnergy {
  if (pace === "fast" || hookScore >= 80) return "high";
  if (pace === "slow" && hookScore < 50) return "low";
  return "medium";
}

function catalogThemes(
  themes: readonly string[] | null | undefined,
): CatalogTheme[] {
  const selected: CatalogTheme[] = [];
  for (const theme of themes ?? []) {
    const normalised = theme.trim().toLowerCase();
    if (!CATALOG_THEME_SET.has(normalised)) continue;
    const allowedTheme = normalised as CatalogTheme;
    if (!selected.includes(allowedTheme)) selected.push(allowedTheme);
    if (selected.length === 4) break;
  }
  return selected;
}

function speechCoverage(input: ShortsProductionInput): number {
  const supplied = input.analysis.speechCoverage;
  if (typeof supplied === "number" && Number.isFinite(supplied)) {
    return clamp(supplied, 0, 1);
  }
  return input.selectedShort.transcript?.trim() ? 0.7 : 0;
}

function motionInstruction(
  sourceKind: SourceMediaKind,
  styleKey: StyleKey,
  tone: ContentTone,
  pace: ContentPace,
  hookScore: number,
  reducedMotion: boolean,
): MotionInstruction {
  if (reducedMotion) {
    return {
      template: "minimal-static",
      reducedMotion: true,
      maxCutsPerMinute: 0,
      captionAnimation: "none",
    };
  }
  if (sourceKind === "audio") {
    return {
      template: "audiogram-waveform",
      reducedMotion: false,
      maxCutsPerMinute: 0,
      captionAnimation: pace === "fast" ? "energetic" : "subtle",
    };
  }
  if (pace === "fast" || hookScore >= 80) {
    return {
      template: "punchy-cuts",
      reducedMotion: false,
      maxCutsPerMinute: 18,
      captionAnimation: "energetic",
    };
  }
  if (
    styleKey === "karaoke_pop" ||
    styleKey === "bounce" ||
    styleKey === "comic_bubble"
  ) {
    return {
      template: "kinetic-captions",
      reducedMotion: false,
      maxCutsPerMinute: 10,
      captionAnimation: "energetic",
    };
  }
  if (tone === "educational") {
    return {
      template: "editorial-focus",
      reducedMotion: false,
      maxCutsPerMinute: 6,
      captionAnimation: "subtle",
    };
  }
  return {
    template: "calm-focus",
    reducedMotion: false,
    maxCutsPerMinute: 4,
    captionAnimation: "subtle",
  };
}

function subtitleProfile(
  hookScore: number,
  pace: ContentPace,
  reducedMotion: boolean,
): SubtitleEmphasisProfile {
  const level: SubtitleEmphasisLevel =
    reducedMotion || (pace === "slow" && hookScore < 50)
      ? "light"
      : pace === "fast" || hookScore >= 80
        ? "high-impact"
        : "balanced";

  if (level === "light") {
    return {
      level,
      autoEmphasis: true,
      maxEmphasizedWordsPerCue: 1,
      triggers: ["numbers", "calls-to-action"],
      animation: "none",
    };
  }
  if (level === "high-impact") {
    return {
      level,
      autoEmphasis: true,
      maxEmphasizedWordsPerCue: 3,
      triggers: ["numbers", "power-words", "calls-to-action"],
      animation: reducedMotion ? "none" : "pop",
    };
  }
  return {
    level,
    autoEmphasis: true,
    maxEmphasizedWordsPerCue: 2,
    triggers: ["numbers", "power-words", "calls-to-action"],
    animation: reducedMotion ? "none" : "subtle",
  };
}

function soundDesignAuthorization(
  input: ShortsProductionInput,
): SoundDesignAuthorization {
  return {
    explicitUserConsent:
      input.soundDesignAuthorization?.explicitUserConsent === true,
    commercialLicenseConfirmed:
      input.soundDesignAuthorization?.commercialLicenseConfirmed === true,
  };
}

function elevenLabsSoundDesignPlan(
  input: ShortsProductionInput,
  durationSeconds: number,
  voiceDucking: VoiceDuckingInstruction,
): ElevenLabsSoundDesignPlan | null {
  if (input.analysis.requestElevenLabsSoundDesign !== true) return null;

  const authorization = soundDesignAuthorization(input);
  const musicDurationMs = Math.round(durationSeconds * 1_000);
  const sfxDurationMax = Math.min(
    MAX_SHORT_SFX_DURATION_SECONDS,
    durationSeconds,
  );

  return {
    provider: "elevenlabs",
    execution:
      authorization.explicitUserConsent &&
      authorization.commercialLicenseConfirmed
        ? "ready-for-authorized-worker"
        : "blocked-pending-consent",
    action: "plan-only",
    authorization: {
      requiresExplicitUserConsent: true,
      explicitUserConsent: authorization.explicitUserConsent,
      commercialLicenseRequired: true,
      commercialLicenseConfirmed: authorization.commercialLicenseConfirmed,
    },
    syntheticVoice: "prohibited",
    shortSfx:
      sfxDurationMax >= ELEVENLABS_SFX_DURATION_BOUNDS_SECONDS.min
        ? {
            modelId: "eleven_text_to_sound_v2",
            maximumEffects: 2,
            providerDurationBoundsSeconds:
              ELEVENLABS_SFX_DURATION_BOUNDS_SECONDS,
            productionDurationBoundsSeconds: {
              min: ELEVENLABS_SFX_DURATION_BOUNDS_SECONDS.min,
              max: sfxDurationMax,
            },
            requestedDurationSeconds: sfxDurationMax,
            loop: false,
            spokenContent: "prohibited",
          }
        : null,
    backgroundMusic:
      musicDurationMs >= ELEVENLABS_MUSIC_DURATION_BOUNDS_MS.min &&
      musicDurationMs <= ELEVENLABS_MUSIC_DURATION_BOUNDS_MS.max
        ? {
            modelId: "music_v2_5",
            providerDurationBoundsMs: ELEVENLABS_MUSIC_DURATION_BOUNDS_MS,
            requestedDurationMs: musicDurationMs,
            instrumentalOnly: true,
            vocalContent: "prohibited",
          }
        : null,
    voiceDucking,
  };
}

/**
 * Build deterministic, provider-neutral Shorts production instructions.
 *
 * Invalid time ranges are rejected before they can reach a renderer. All
 * dynamic catalog labels are allow-listed and visual analysis remains only an
 * explicit request descriptor, never an analysis call.
 */
export function mapShortsProductionInstructions(
  input: ShortsProductionInput,
): ShortsProductionInstructions {
  const { selectedShort, analysis } = input;
  const { startSeconds, endSeconds } = selectedShort;
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    throw new RangeError("selected_short_time_range_invalid");
  }

  const rawDurationSeconds = endSeconds - startSeconds;
  if (rawDurationSeconds > MAX_SHORT_DURATION_SECONDS) {
    throw new RangeError("selected_short_duration_exceeds_limit");
  }
  const durationSeconds = roundSeconds(rawDurationSeconds);

  const hookScore =
    typeof analysis.hookScore === "number" &&
    Number.isFinite(analysis.hookScore)
      ? clamp(analysis.hookScore, 0, 100)
      : 0;
  const tone = validTone(analysis.tone);
  const pace = validPace(analysis.pace);
  const reducedMotion = input.reducedMotion === true;
  const mood = musicMood(tone, pace, hookScore);
  const [minBpm, maxBpm] = BPM_BY_MOOD[mood];
  const coveredSpeech = speechCoverage(input);

  const visualAnalysis =
    selectedShort.sourceKind === "video" &&
    analysis.requestVisualAnalysis === true
      ? {
          kind: "selected-short-visual-analysis" as const,
          requiresExplicitUserConsent: true as const,
          sourceScope: "selected-short-only" as const,
          startSeconds,
          endSeconds,
          sampleRateFps: 1 as const,
          outputs: [
            "shot-boundaries",
            "subject-framing",
            "motion-level",
          ] as const,
          includeAudio: false as const,
          faceRecognition: "disabled" as const,
          retainFrames: false as const,
          externalTransfer: "disabled" as const,
        }
      : null;

  const voiceDucking: VoiceDuckingInstruction =
    coveredSpeech > 0
      ? {
          enabled: true,
          musicGainDuringSpeechDb:
            coveredSpeech >= 0.7 ? -22 : coveredSpeech >= 0.3 ? -18 : -14,
          attackMs: 80,
          releaseMs: 280,
        }
      : {
          enabled: false,
          musicGainDuringSpeechDb: null,
          attackMs: null,
          releaseMs: null,
        };

  return {
    selectedShort: {
      startSeconds,
      endSeconds,
      durationSeconds,
      aspectRatio: selectedShort.aspectRatio,
      sourceKind: selectedShort.sourceKind,
    },
    music: {
      action: "recommend-only",
      generated: false,
      mood,
      energy: musicEnergy(pace, hookScore),
      catalogQuery: {
        source: "licensed-catalog-only",
        musicGeneration: "never",
        requiredLicense: "commercial-social-sync",
        instrumentalOnly: true,
        excludeExplicitContent: true,
        targetBpm: { min: minBpm, max: maxBpm },
        moods: [mood],
        themes: catalogThemes(analysis.themes),
        maxTrackDurationSeconds: Math.ceil(durationSeconds),
      },
    },
    elevenLabsSoundDesign: elevenLabsSoundDesignPlan(
      input,
      durationSeconds,
      voiceDucking,
    ),
    voiceDucking,
    motion: motionInstruction(
      selectedShort.sourceKind,
      selectedShort.styleKey,
      tone,
      pace,
      hookScore,
      reducedMotion,
    ),
    subtitles: subtitleProfile(hookScore, pace, reducedMotion),
    visualAnalysis,
    creativeDirector: {
      provider: "anthropic",
      model: "Claude Opus 5.5",
      availability: "waiting-for-official-api-model-id",
      action: "creative-direction-plan-only",
      scope: "selected-short-only",
      candidatePolicy: "final-selection-only",
      expectedOutputs: [
        "motion-beat-sheet",
        "subtitle-emphasis-refinement",
        "sound-placement-guidance",
      ],
    },
  };
}
