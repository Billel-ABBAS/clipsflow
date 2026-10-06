/**
 * Returns whether Shorts rendering should avoid decorative motion.
 *
 * `minimal-static` is a creative preset; `reducedMotion` is the explicit
 * accessibility preference. Both disable animated effects while keeping
 * timed captions and all other content visible.
 */
export function shouldReduceShortsMotion(
  reducedMotion?: boolean,
  motionTemplate?: string,
): boolean {
  return reducedMotion === true || motionTemplate === "minimal-static";
}
