// ============================================================================
// ClipsFlow Clips — quota + plan customization stripping
// ============================================================================
// Two responsibilities :
//   1. `checkClipAccess()` — server-side gate. Atomically reserves
//      `seconds` against the resolved plan's monthly quota via the
//      `clips_reserve_quota` RPC.
//   2. `stripCustomizationsByPlan()` — pure fn, fail-closed. Drops any
//      customization a user's plan is not entitled to. Used by the
//      submit route and by tests + UI preview rendering.
//
// Plan matrix (ClipsFlow P1) :
//   free / solo → no customization (everything stripped)
//   pro         → text_color + highlight_color from PRO_COLOR_PALETTE
//                 only ; off-palette hex → undefined
//   studio      → free hex colors + font from CURATED_FONTS + position +
//                 stroke / emphasis / animation sliders
//
// Quota (seconds of rendered clip per month) :
//   free 60 / solo 480 / pro 1800 / studio 3600
//
// Ported from VidiaFlow src/lib/clipflow/subtitle-quota.ts.
// Adaptations :
//   - QUOTAS_SECONDS matrix : {free, solo, pro, studio} (the VidiaFlow
//     'creator' tier maps to 'solo' with the same {} strip behaviour ;
//     'agency' has no ClipsFlow equivalent — its full-pass-through branch
//     is removed, 'studio' is the top tier).
//   - `stripCustomizationsByTier` renamed `stripCustomizationsByPlan`
//     (logic ported verbatim for the surviving tiers).
//   - `checkSubtitleAccess` → `checkClipAccess` : calls the
//     `clips_reserve_quota` RPC (returns boolean — not the {reserved,
//     used} record of the VidiaFlow RPC) and returns {allowed, remaining?}.
//   - NEW `resolvePlan()` : P1 has no profiles.plan column — every user
//     resolves to the constant DEFAULT_PLAN ('pro').
//   - NEW `refundClipSeconds()` : wraps the `clips_refund_quota` RPC
//     (the VidiaFlow refund lived inline in the cron error handler).
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { PRO_COLOR_PALETTE, CURATED_FONTS } from "./subtitle-styles";
import type { SubtitleCustomizations } from "./types";

export const QUOTAS_SECONDS = {
  free: 60,
  solo: 480,
  pro: 1800,
  studio: 3600,
} as const;

export type Plan = keyof typeof QUOTAS_SECONDS;

const PLAN_ORDER: readonly Plan[] = ["free", "solo", "pro", "studio"];

// ─────────────────────────────────────────────────────────────────────────────
// resolvePlan — source unique du tier d'un profile.
//
// Lit `profiles.plan` (créée par la migration 0003_stripe_billing.sql).
// La valeur est validée contre QUOTAS_SECONDS ; toute valeur inconnue
// retombe sur 'free' (fail-closed, principe de moindre privilège).
// ─────────────────────────────────────────────────────────────────────────────

interface ProfileWithPlan {
  plan?: string | null;
}

export function resolvePlan(profile: ProfileWithPlan | null | undefined): Plan {
  const raw = profile?.plan;
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower in QUOTAS_SECONDS) {
      return lower as Plan;
    }
  }
  return "free";
}

/**
 * Strict 6-digit hex matcher : `#` + exactly 6 hex chars (case-insensitive).
 */
const HEX_RE = /^#[0-9a-f]{6}$/i;

export function validHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Returns the next tier "up" the plan ladder or null at the top. */
export function nextPlan(plan: Plan): Plan | null {
  const idx = PLAN_ORDER.indexOf(plan);
  if (idx === -1) return null;
  return PLAN_ORDER[idx + 1] ?? null;
}

/**
 * Strip customizations the user's plan is not entitled to. Fail-closed :
 * unknown plan codes (e.g. legacy 'agency', typo) return `{}`.
 *
 * Pure fn — no I/O. Safe to call from UI preview code.
 *
 * Ported verbatim from VidiaFlow `stripCustomizationsByTier` for the
 * surviving tiers (free/creator → free/solo, pro, studio). The VidiaFlow
 * 'agency' full-pass-through branch is removed — studio is the top tier.
 */
export function stripCustomizationsByPlan(
  plan: string | null | undefined,
  custom?: SubtitleCustomizations,
): SubtitleCustomizations {
  const c = custom ?? {};
  switch (plan as Plan) {
    case "free":
    case "solo":
      // Lock to style defaults — no overrides allowed.
      return {};

    case "pro": {
      // Keep only colors from PRO_COLOR_PALETTE. Other fields stripped.
      const palette = PRO_COLOR_PALETTE as readonly string[];
      const text =
        validHex(c.text_color) && palette.includes(c.text_color!)
          ? c.text_color
          : undefined;
      const highlight =
        validHex(c.highlight_color) && palette.includes(c.highlight_color!)
          ? c.highlight_color
          : undefined;
      return { text_color: text, highlight_color: highlight };
    }

    case "studio": {
      // Free hex colors + font restricted to CURATED_FONTS + stroke_width
      // slider + position picker + fine-tune position_y + emphasis /
      // animation controls (top tier in ClipsFlow).
      const fonts = CURATED_FONTS as readonly string[];
      const font = c.font && fonts.includes(c.font) ? c.font : undefined;
      const position =
        c.position === "top" ||
        c.position === "middle" ||
        c.position === "lower_third" ||
        c.position === "bottom"
          ? c.position
          : undefined;
      return {
        ...c,
        text_color: validHex(c.text_color) ? c.text_color : undefined,
        highlight_color: validHex(c.highlight_color)
          ? c.highlight_color
          : undefined,
        background_color: validHex(c.background_color)
          ? c.background_color
          : undefined,
        background_opacity:
          typeof c.background_opacity === "number"
            ? clamp(c.background_opacity, 0, 100)
            : undefined,
        position,
        position_y:
          typeof c.position_y === "number"
            ? clamp(c.position_y, 0, 100)
            : undefined,
        font,
        stroke_width:
          typeof c.stroke_width === "number"
            ? clamp(c.stroke_width, 0, 12)
            : undefined,
        auto_emphasis:
          typeof c.auto_emphasis === "boolean" ? c.auto_emphasis : undefined,
        animation_speed:
          typeof c.animation_speed === "number"
            ? clamp(c.animation_speed, 0.5, 2)
            : undefined,
        emphasis_colors: Array.isArray(c.emphasis_colors)
          ? c.emphasis_colors
              .filter((h): h is string => validHex(h))
              .slice(0, 5)
          : undefined,
      };
    }

    default:
      // Unknown plan → fail-closed (lock to defaults).
      return {};
  }
}

export interface ClipAccessResult {
  allowed: boolean;
  /** Seconds left this month AFTER the reservation (or current headroom
   *  when denied). Omitted when the profile read failed. */
  remaining?: number;
  /** Set when allowed=false. */
  reason?: "clip_quota_exceeded";
}

/**
 * Server-side gate. Resolves the user's plan, then atomically reserves
 * `seconds` against `QUOTAS_SECONDS[plan]` via the `clips_reserve_quota`
 * RPC.
 *
 * The RPC closes the gate-vs-increment race : Postgres serializes the
 * `UPDATE ... WHERE used + p_seconds <= p_limit RETURNING`, so two
 * concurrent submits cannot both pass.
 *
 * Fail-closed : an RPC error is treated as quota-exceeded rather than
 * silently letting the user through.
 *
 * @throws "profile_not_found" if the profile row is missing.
 */
export async function checkClipAccess(
  supabase: SupabaseClient,
  userId: string,
  seconds: number,
): Promise<ClipAccessResult> {
  // Fetch the profile first — drives plan resolution (constant in P1, real
  // column in P3) and gives us `used` for the remaining computation.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, clip_seconds_used_this_month, plan")
    .eq("id", userId)
    .single();
  if (!profile) throw new Error("profile_not_found");

  const plan = resolvePlan(profile);
  const limit = QUOTAS_SECONDS[plan] ?? 0;
  const used = (profile.clip_seconds_used_this_month as number | null) ?? 0;

  const { data: reserved, error: reserveError } = await supabase.rpc(
    "clips_reserve_quota",
    { p_user_id: userId, p_seconds: seconds, p_limit: limit },
  );
  if (reserveError || reserved !== true) {
    return {
      allowed: false,
      reason: "clip_quota_exceeded",
      remaining: Math.max(0, limit - used),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, limit - used - seconds),
  };
}

/**
 * RÈGLE ANTI-DOUBLE-REFUND (review Lot 2 — encodée ici, consommée par le
 * cron /api/cron/process-clips).
 *
 * Le quota est réservé au moment du POST /api/clips/jobs (checkClipAccess
 * → clips_reserve_quota). Le cron refund (refundClipSeconds) UNIQUEMENT
 * quand un job FRAIS échoue terminalement APRÈS cette réservation.
 *
 * Les préfixes ci-dessous signalent un job invalide / re-run d'un clip
 * déjà terminal — PAS un échec de pipeline post-réservation :
 *   - invalid_job:         jobs row forgée/corrompue (mauvais type, pas de
 *                          clip_id, owner mismatch) — aucune réservation
 *                          rattachable à ce job
 *   - clip_not_found:      la row clips a disparu — rien à refund (le
 *                          DELETE CASCADE episode→clips→jobs emporte les
 *                          jobs ; ce préfixe n'apparaît que sur une row
 *                          jobs incohérente)
 *   - episode_not_found:   même classe — l'épisode parent a disparu hors
 *                          cascade (row corrompue)
 *   - invalid_clip_status: re-run d'un clip déjà completed/failed — le
 *                          quota a déjà été servi (completed) ou déjà
 *                          refundé (failed) ; refund ici = double refund
 *
 * Tout AUTRE préfixe (invalid_source_url, source_download_failed,
 * source_too_large, invalid_source_file, segment_too_long,
 * segment_extract_failed, whisper_failed, no_speech_detected,
 * translation_*, audiogram_failed, subtitle_burn_failed, upload_failed,
 * stuck_timeout…) est un échec réel post-réservation → refund.
 *
 * Les valeurs sont les préfixes SANS le `:` final — à comparer au résultat
 * de l'extraction `/^([^:\s]+):\s/` côté cron.
 */
export const REFUND_EXCLUDED_PREFIXES = [
  "invalid_job",
  "clip_not_found",
  "episode_not_found",
  "invalid_clip_status",
] as const;

/**
 * Refund `seconds` to the user's monthly quota via the
 * `clips_refund_quota` RPC (clamped at 0 server-side). Called by the cron
 * error handler when a render fails AFTER the quota was reserved.
 *
 * Best-effort : an RPC failure is logged, never thrown — the failure
 * handling path must not crash on a refund hiccup.
 */
export async function refundClipSeconds(
  supabase: SupabaseClient,
  userId: string,
  seconds: number,
): Promise<void> {
  const { error } = await supabase.rpc("clips_refund_quota", {
    p_user_id: userId,
    p_seconds: seconds,
  });
  if (error) {
    console.warn(
      `[clips-quota] refund failed user=${userId} seconds=${seconds} error=${error.message.slice(0, 200)}`,
    );
  }
}
