// ============================================================================
// ClipsFlow Clips — Web Share API detection helper
// ============================================================================
// Pure helper for feature-detecting navigator.share availability. Extracted
// so unit tests can import it without pulling React + next-intl.
//
// Ported from VidiaFlow src/lib/clipflow/web-share.ts (unchanged logic).
// ============================================================================

/** Pure feature-detection — true when navigator.share is callable. */
export function supportsWebShare(nav: Navigator | null | undefined): boolean {
  if (!nav) return false;
  return typeof nav.share === "function";
}
