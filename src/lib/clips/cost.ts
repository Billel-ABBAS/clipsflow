// ============================================================================
// ClipsFlow Clips — per-clip cost computation
// ============================================================================
// Computes a $-denominated cost estimate for a single clip render job.
// Persisted on `clips.cost_usd` so an admin dashboard can roll up daily /
// monthly cost per user and plan.
//
// **Why an estimate, not a measurement** : the actual COGS is split
// across 3 vendors (Groq Whisper API call, Vercel lambda compute,
// Supabase Storage egress + storage). Vercel + Supabase don't expose
// per-request cost in real time — billing is monthly aggregated.
// So we compute a deterministic estimate based on durationSeconds.
// Order of magnitude correct (±20 %) ; good enough for margin tracking
// and red-flag alerts.
//
// **Inputs** : durationSeconds (clip length).
//
// **Pricing constants** :
//   - Groq Whisper Large v3 Turbo : $0.04 / hour audio = $0.0000111 / s
//   - Supabase Storage : $0.021 / GB-month (Pro plan beyond 100 GB free)
//   - Supabase egress : $0.09 / GB (Pro plan beyond 250 GB free)
//   - Vercel function compute : amortized $0.000005 / s on 2-vCPU lambda
//
// Ported from VidiaFlow src/lib/clipflow/cost.ts.
// Adaptation : mono-resolution 1080p — the `ResolutionTier` type and the
// 2K/4K `RESOLUTION_MULTIPLIER` map are removed (ClipsFlow P1 renders
// 1080p only). The 1080p multiplier was 1.0, so the arithmetic is
// unchanged for the remaining path.
// ============================================================================

const WHISPER_COST_PER_SEC = 0.0000111;
const STORAGE_1080P_PER_CLIP = 0.000525; // 25 MB × $0.021 / GB
const BANDWIDTH_1080P_PER_CLIP = 0.00225; // 25 MB × $0.09 / GB (1 download avg)
const COMPUTE_PER_SEC = 0.000005;

/**
 * Estimate the all-in cost in USD for a single 1080p clip render.
 * Returns a number rounded to 6 decimal places (sub-cent precision —
 * matches the precision of the `clips.cost_usd` numeric column).
 */
export function computeClipCost(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;

  const whisper = durationSeconds * WHISPER_COST_PER_SEC;
  const ioCosts = STORAGE_1080P_PER_CLIP + BANDWIDTH_1080P_PER_CLIP;
  const compute = durationSeconds * COMPUTE_PER_SEC;

  const total = whisper + ioCosts + compute;
  return Math.round(total * 1e6) / 1e6;
}
