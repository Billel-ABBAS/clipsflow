// ============================================================================
// ClipsFlow — GET /api/cron/process-clips (drain worker, 1 job/tick)
// ============================================================================
// Fréquence cible : * * * * * (chaque minute — cf. vercel.json).
//
// Draine la queue `jobs` (type 'render'). Porté de VidiaFlow
// /api/cron/process-clip-jobs en conservant sa structure. Chaque tick :
//
//   1. Guard Bearer fail-CLOSED (CRON_SECRET — src/lib/cron/guard.ts).
//   2. Stuck-recovery : rows `jobs` status 'processing' avec
//      claimed_at < now()-450s (= maxDuration × 1.5, le worker précédent
//      est mort au SIGKILL Vercel) :
//        - attempt_count = 0 → reset 'pending' (+1 attempt, claimed_at
//          null) ; le clip lié repasse 'pending' aussi. Couvre les spikes
//          transitoires sans re-submit manuel.
//        - attempt_count ≥ 1 → jobs + clips 'failed'
//          (error_message "stuck_timeout") + REFUND (le stuck n'est PAS
//          dans REFUND_EXCLUDED_PREFIXES — c'est un échec post-réservation
//          d'un job frais).
//   3. Claim atomique d'UN job via claimNextJob (race-safe : plusieurs
//      lambdas cron concurrentes traitent des jobs distincts).
//   4. Clip lié → 'processing', puis runRenderJob.
//   5. Succès → clips 'completed' (+ URLs/score/hook/cost) + jobs
//      'completed'. Échec → extraction du préfixe d'erreur, Sentry
//      fail-soft, refund SAUF préfixes exclus (règle anti-double-refund,
//      voir REFUND_EXCLUDED_PREFIXES dans src/lib/clips/quota.ts), clips +
//      jobs 'failed'.
//
// TOUJOURS répondre 200 { ok: true, … } sur un tick drainé (même failed) :
// un cron qui 500 boucle en alertes plateforme sans valeur ajoutée — les
// échecs de jobs sont déjà routés vers Sentry + la row porte l'erreur.
//
// Adaptations vs source : withCronContext (request-context observability)
// non porté — ClipsFlow n'a pas le module ; les tags Sentry du capture
// couvrent le besoin de tri. retry_count → attempt_count (colonne 0002).
// ============================================================================

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { guardCronRequest } from "@/lib/cron/guard";
import { claimNextJob } from "@/lib/clips/claim-job";
import { runRenderJob } from "@/lib/clips/run-job";
import { refundClipSeconds, REFUND_EXCLUDED_PREFIXES } from "@/lib/clips/quota";

export const runtime = "nodejs";
// Whisper ~30 s + extract ~10 s + burn ~30 s + uploads ~10 s = nominal
// ~80 s, p99 ~180 s. 300 s donne du slack — au-delà, le stuck-recovery du
// tick suivant reprend la row.
export const maxDuration = 300;

// STUCK_THRESHOLD = maxDuration × 1.5 (pattern audit VidiaFlow M1) : marge
// de 2,5 min après le SIGKILL Vercel pour ne jamais sweeper un job vivant.
const STUCK_THRESHOLD_MS = Math.floor(maxDuration * 1.5 * 1000); // 450 000 ms

/** Logger JSON une-ligne (même shim que run-job.ts). */
const logger = {
  warn(message: string, ctx: Record<string, unknown> = {}): void {
    console.warn(
      JSON.stringify({
        level: "warn",
        source: "cron-process-clips",
        message,
        ...ctx,
      }),
    );
  },
  error(message: string, ctx: Record<string, unknown> = {}): void {
    console.error(
      JSON.stringify({
        level: "error",
        source: "cron-process-clips",
        message,
        ...ctx,
      }),
    );
  },
};

/**
 * Sentry capture fail-soft pour le pipeline de drain (port de
 * captureClipflowError, audit OBS-1) : si la capture elle-même throw
 * (blip réseau, SDK non initialisé), on avale l'erreur secondaire — le
 * logger + l'UPDATE de la row continuent de tracer l'échec.
 */
function captureCronError(
  err: unknown,
  tags: Record<string, string | undefined>,
  extra: Record<string, unknown>,
): void {
  try {
    Sentry.captureException(err, {
      tags: { feature: "clips", cron_route: "process-clips", ...tags },
      extra,
    });
  } catch {
    // Sentry a échoué — ne pas cascader dans le cron.
  }
}

/**
 * Extraction du préfixe d'erreur (pattern source, audit L2) : ne matche
 * `:` que s'il est suivi d'un whitespace (codes structurés type
 * `invalid_source_url: https://…`) — sinon une URL donnerait `https`.
 */
function extractErrorPrefix(errMsg: string): string {
  const m = errMsg.match(/^([^:\s]+):\s/);
  return m ? m[1]! : (errMsg.split(/\s/)[0] ?? "unknown");
}

export async function GET(request: Request): Promise<Response> {
  // 1. Guard fail-CLOSED.
  const unauth = guardCronRequest(request, "process-clips");
  if (unauth) return unauth;

  // Cut-over guard: once the Railway worker has passed staging and this
  // variable is set in Vercel, its existing cron invocation becomes a cheap
  // no-op. This prevents two schedulers from claiming the same queue while a
  // follow-up deployment removes the Vercel schedule itself.
  if (process.env.CLIPS_WORKER_BACKEND === "railway") {
    return NextResponse.json({ ok: true, skipped: "railway_worker_active" });
  }

  const admin = createAdminClient();
  const nowIso = () => new Date().toISOString();

  // ── 2. Stuck-recovery ──────────────────────────────────────────────────
  const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();

  // 2a. Premier timeout (attempt_count = 0) → retry : reset 'pending',
  // attempt_count → 1, claimed_at null. Le filtre .eq(attempt_count, 0)
  // rend le set à 1 équivalent à un incrément atomique.
  const { data: retriedJobs } = await admin
    .from("jobs")
    .update({ status: "pending", attempt_count: 1, claimed_at: null })
    .eq("status", "processing")
    .eq("type", "render")
    .eq("attempt_count", 0)
    .lt("claimed_at", stuckCutoff)
    .select("id, clip_id");
  const retriedClipIds = (retriedJobs ?? [])
    .map((j) => j.clip_id as string | null)
    .filter((id): id is string => typeof id === "string");
  if (retriedClipIds.length > 0) {
    // Le clip lié repasse 'pending' aussi (uniquement depuis 'processing' —
    // ne touche jamais un état terminal).
    await admin
      .from("clips")
      .update({ status: "pending" })
      .in("id", retriedClipIds)
      .eq("status", "processing");
  }

  // 2b. Second timeout (attempt_count ≥ 1) → échec permanent + refund.
  const { data: stuckFailedJobs } = await admin
    .from("jobs")
    .update({
      status: "failed",
      error_message: "stuck_timeout",
      completed_at: nowIso(),
    })
    .eq("status", "processing")
    .eq("type", "render")
    .gte("attempt_count", 1)
    .lt("claimed_at", stuckCutoff)
    .select("id, user_id, clip_id");
  const stuckClipIds = (stuckFailedJobs ?? [])
    .map((j) => j.clip_id as string | null)
    .filter((id): id is string => typeof id === "string");
  if (stuckClipIds.length > 0) {
    // Ne bascule en 'failed' QUE les clips encore pending/processing : un
    // clip 'completed' (worker mort entre l'update clips et l'update jobs)
    // a déjà servi le user — pas de refund, pas d'écrasement. Les refunds
    // sont dérivés des rows effectivement basculées par CE update →
    // jamais de double refund avec le chemin d'échec standard.
    const { data: failedClips } = await admin
      .from("clips")
      .update({
        status: "failed",
        error_message: "stuck_timeout",
        completed_at: nowIso(),
      })
      .in("id", stuckClipIds)
      .in("status", ["pending", "processing"])
      .select("id, user_id, duration_seconds");
    for (const c of failedClips ?? []) {
      const seconds = (c.duration_seconds as number | null) ?? 0;
      if (seconds > 0) {
        await refundClipSeconds(admin, c.user_id as string, seconds);
      }
    }
  }
  if ((retriedJobs?.length ?? 0) + (stuckFailedJobs?.length ?? 0) > 0) {
    logger.warn("stuck recovery", {
      retried: retriedJobs?.length ?? 0,
      failed: stuckFailedJobs?.length ?? 0,
    });
  }

  // ── 3. Claim atomique d'UN job 'render' ────────────────────────────────
  const job = await claimNextJob(admin, "render");
  if (!job) return NextResponse.json({ ok: true, drained: 0 });

  const payloadClipId =
    typeof job.payload?.clip_id === "string" ? job.payload.clip_id : null;
  const clipId = job.clip_id ?? payloadClipId;

  // ── 4. Clip lié → 'processing' avant le run ────────────────────────────
  if (clipId) {
    await admin
      .from("clips")
      .update({ status: "processing" })
      .eq("id", clipId)
      .eq("status", "pending");
  }

  // ── 5. Run pipeline ────────────────────────────────────────────────────
  try {
    const result = await runRenderJob(admin, job);
    // runRenderJob a validé type='render' + clip_id non-null (sinon il
    // aurait throw `invalid_job:`) — clipId est garanti ici.
    await admin
      .from("clips")
      .update({
        status: "completed",
        video_url: result.video_url,
        video_storage_path: result.video_storage_path,
        captions_vtt_url: result.captions_vtt_url,
        captions_vtt_storage_path: result.captions_vtt_storage_path,
        cost_usd: result.cost_usd,
        score: result.score,
        hook_text: result.hook_text,
        completed_at: nowIso(),
      })
      .eq("id", clipId!);
    await admin
      .from("jobs")
      .update({ status: "completed", completed_at: nowIso() })
      .eq("id", job.id);
    return NextResponse.json({ ok: true, drained: 1, job_id: job.id });
  } catch (err) {
    const errMsg = (err as Error).message;
    const errorPrefix = extractErrorPrefix(errMsg);
    logger.error("render job failed", {
      job_id: job.id,
      clip_id: clipId,
      error_prefix: errorPrefix,
      error: errMsg.slice(0, 400),
    });
    captureCronError(
      err,
      {
        job_id: job.id,
        user_id: job.user_id,
        error_prefix: errorPrefix,
      },
      {
        error_message: errMsg.slice(0, 400),
        clip_id: clipId,
        attempt_count: job.attempt_count,
      },
    );

    // RÈGLE ANTI-DOUBLE-REFUND — le quota a été réservé au POST
    // /api/clips/jobs ; on refund UNIQUEMENT un job frais qui échoue
    // terminalement après cette réservation. Les préfixes de
    // REFUND_EXCLUDED_PREFIXES (invalid_job / clip_not_found /
    // episode_not_found / invalid_clip_status) signalent une row invalide
    // ou le re-run d'un clip déjà terminal = déjà refundé ou déjà servi.
    const isExcluded = (REFUND_EXCLUDED_PREFIXES as readonly string[]).includes(
      errorPrefix,
    );
    if (!isExcluded && clipId) {
      const { data: clipRow } = await admin
        .from("clips")
        .select("user_id, duration_seconds")
        .eq("id", clipId)
        .maybeSingle();
      const seconds = (clipRow?.duration_seconds as number | null) ?? 0;
      if (clipRow && seconds > 0) {
        await refundClipSeconds(admin, clipRow.user_id as string, seconds);
        logger.warn("quota refunded", {
          job_id: job.id,
          clip_id: clipId,
          error_prefix: errorPrefix,
          refunded_seconds: seconds,
        });
      }
    }

    // Stamp clips 'failed' (error_message tronqué 400 chars, préfixe
    // inclus puisque errMsg commence par lui). Guard pending/processing :
    // ne JAMAIS écraser un clip terminal (cas invalid_clip_status — le
    // clip completed/failed reste tel quel).
    if (clipId) {
      await admin
        .from("clips")
        .update({
          status: "failed",
          error_message: errMsg.slice(0, 400),
          completed_at: nowIso(),
        })
        .eq("id", clipId)
        .in("status", ["pending", "processing"]);
    }
    await admin
      .from("jobs")
      .update({
        status: "failed",
        error_message: errMsg.slice(0, 400),
        completed_at: nowIso(),
      })
      .eq("id", job.id);

    // 200 même sur échec de job : le tick a fait son travail de drain.
    return NextResponse.json({
      ok: true,
      drained: 1,
      failed: true,
      job_id: job.id,
    });
  }
}
