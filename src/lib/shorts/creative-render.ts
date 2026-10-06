import type { CreativeDirectorResult } from "@/lib/clips/creative-director";
import type { ClipJob } from "@/lib/clips/types";
import { shortsMotionAnimationSpeed } from "./render-submission";

export type ShortsRenderProfile = NonNullable<
  ClipJob["customizations"]["shorts"]
>;

/** Apply only allow-listed creative fields; the renderer remains deterministic. */
export function applyCreativeDirectionToShortsProfile(
  profile: ShortsRenderProfile,
  direction: CreativeDirectorResult,
): ShortsRenderProfile & { music_prompt: string } {
  const motionTemplate = profile.reduced_motion
    ? "minimal-static"
    : direction.motion.template;
  const cache = profile.creative_direction.cache;
  return {
    ...profile,
    title: direction.title,
    hook: direction.hook,
    music_mood: direction.music.mood,
    motion_template: motionTemplate,
    music_prompt: direction.music.instrumental_prompt,
    creative_direction: {
      ...profile.creative_direction,
      ...(cache ? { cache } : {}),
    },
  };
}

/** Use the first model-planned accent only, keeping extra provider usage bounded. */
export function resolveCreativeSoundAccent(
  direction: CreativeDirectorResult,
  shortDurationSeconds: number,
): { prompt: string; atSeconds: number; durationSeconds: number } | null {
  const beat = direction.motion.beat_sheet.find(
    (candidate) => candidate.action === "sound-accent",
  );
  if (!beat) return null;

  return {
    prompt: [
      "One short, subtle, non-verbal sound effect for a short-form edit.",
      `Creative cue: ${beat.detail}`,
      "No voice, words, lyrics, music, or imitation of a real person.",
    ].join(" "),
    atSeconds: beat.at_seconds,
    durationSeconds: Math.min(1.5, Math.max(0.6, shortDurationSeconds / 30)),
  };
}

export function creativeMotionAnimationSpeed(
  profile: ShortsRenderProfile,
  direction: CreativeDirectorResult,
): number {
  const baseSpeed = shortsMotionAnimationSpeed(
    profile.reduced_motion ? "minimal-static" : direction.motion.template,
    profile.reduced_motion,
  );
  if (profile.reduced_motion) return baseSpeed;
  const multiplier =
    direction.motion.intensity === "subtle"
      ? 0.9
      : direction.motion.intensity === "energetic"
        ? 1.1
        : 1;
  return Math.max(0.5, Math.min(2, baseSpeed * multiplier));
}
