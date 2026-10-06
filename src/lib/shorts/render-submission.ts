import { createHash } from "node:crypto";

import type { ShortsProductionProfile } from "./project-contract";

/** A Short is not renderable until its adapted instrumental bed is authorized. */
export function hasAuthorizedShortsMusic(
  profile: ShortsProductionProfile,
): boolean {
  const authorization = profile.elevenlabs;
  return (
    authorization.enabled &&
    authorization.explicit_consent &&
    authorization.commercial_license_confirmed &&
    authorization.synthetic_voice === false &&
    authorization.use_cases.includes("instrumental_music")
  );
}

/**
 * Stable per-candidate/profile key: a retried batch reuses the same render,
 * while changing a production setting intentionally creates a new render.
 */
export function shortsRenderRequestId(
  projectId: string,
  candidateId: string,
  profile: ShortsProductionProfile,
): string {
  const digest = createHash("sha256")
    .update(`${projectId}:${candidateId}:${JSON.stringify(profile)}`)
    .digest()
    .subarray(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function shortsMotionAnimationSpeed(
  template: ShortsProductionProfile["motion"]["template"],
  reducedMotion: boolean,
): number {
  if (reducedMotion) return 0.75;
  switch (template) {
    case "punchy-cuts":
      return 1.4;
    case "kinetic-captions":
      return 1.2;
    case "calm-focus":
      return 0.8;
    case "minimal-static":
      return 0.5;
    case "editorial-focus":
    case "audiogram-waveform":
      return 1;
  }
}

export function shortsTitleCardOverlay(
  title: string,
  hook: string,
  durationSeconds: number,
  template: ShortsProductionProfile["motion"]["template"],
): {
  type: "title_card";
  text: string;
  subtitle?: string;
  startSec: number;
  endSec: number;
  font: string;
  animationPreset: "punch" | "kinetic" | "editorial" | "calm";
} | null {
  if (template === "minimal-static") return null;
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 60);
  const safeHook = hook
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 80);
  if (!safeTitle || !Number.isFinite(durationSeconds) || durationSeconds < 10) {
    return null;
  }
  return {
    type: "title_card",
    text: safeTitle,
    ...(safeHook ? { subtitle: safeHook } : {}),
    startSec: 0,
    endSec: Math.min(2.5, durationSeconds / 4),
    font: "Inter Bold",
    animationPreset:
      template === "punchy-cuts"
        ? "punch"
        : template === "kinetic-captions"
          ? "kinetic"
          : template === "calm-focus"
            ? "calm"
            : "editorial",
  };
}
