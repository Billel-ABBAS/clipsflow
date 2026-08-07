// ============================================================================
// ClipsFlow Clips — onboarding flag helpers
// ============================================================================
// Pure helpers for the onboarding hero localStorage flag. Extracted so unit
// tests can import them without pulling React + next-intl into the runner.
//
// Ported from VidiaFlow src/lib/clipflow/onboarding-storage.ts.
// Adaptation : localStorage key prefix changed from "vf-" to "ClipsFlow-".
// ============================================================================

export const ONBOARDING_LOCAL_STORAGE_KEY = "ClipsFlow-onboarding-clips";
export const ONBOARDING_DISMISSED_VALUE = "dismissed";

/** Returns true if the onboarding hero should mount. SSR-safe : returns
 *  false when `storage` is null. */
export function shouldShowClipsOnboarding(storage: Storage | null): boolean {
  if (!storage) return false;
  try {
    return (
      storage.getItem(ONBOARDING_LOCAL_STORAGE_KEY) !==
      ONBOARDING_DISMISSED_VALUE
    );
  } catch {
    // Privacy-mode browsers throw on getItem. Default to NOT showing.
    return false;
  }
}

export function dismissClipsOnboarding(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_LOCAL_STORAGE_KEY, ONBOARDING_DISMISSED_VALUE);
  } catch {
    /* best-effort */
  }
}
