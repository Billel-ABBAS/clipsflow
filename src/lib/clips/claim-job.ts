// src/lib/clips/claim-job.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueueJob, QueueJobType } from "./types";

/**
 * Atomically claim the next pending clip job from the `jobs` table.
 *
 * Race semantics : SELECT id WHERE status='pending' ORDER BY created_at ASC
 * LIMIT batch, then UPDATE … WHERE id=X AND status='pending' RETURNING *.
 * If 0 rows updated, another worker won the race — try the next candidate.
 *
 * Per-user FAIRNESS (mirrors claimNextJob in VidiaFlow async-jobs.ts) :
 *   1. Pull a batch ordered by `created_at ASC`.
 *   2. Group by `user_id` and take each user's OLDEST pending job.
 *   3. Shuffle the per-user slice so concurrent workers don't all hammer
 *      the same user's head-of-line.
 * Result : 1 abusive user with 30 jobs no longer starves the queue.
 *
 * Ported from VidiaFlow src/lib/clipflow/claim-job.ts.
 * Adaptation : operates on `jobs` table (status pending → processing,
 * claimed_at = now) instead of `clip_subtitle_jobs`. The `enqueue_mode`
 * filter is dropped — the ClipsFlow jobs table has no client-side burn path
 * in this phase.
 */
export async function claimNextJob(
  supabase: SupabaseClient,
  type?: QueueJobType,
): Promise<QueueJob | null> {
  const CANDIDATE_BATCH = 30;

  let query = supabase
    .from("jobs")
    .select("id, user_id, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_BATCH);

  if (type) {
    query = query.eq("type", type);
  }

  const { data: candidatesRaw } = await query;

  const candidates = (candidatesRaw ?? []) as Array<{
    id: string;
    user_id: string | null;
    created_at: string;
  }>;
  if (candidates.length === 0) return null;

  // Group by user_id, take each user's oldest. Null user_id (defensive)
  // clusters under the same null bucket.
  const oldestPerUser = new Map<string, { id: string; created_at: string }>();
  for (const c of candidates) {
    const userKey = c.user_id ?? "__null__";
    const existing = oldestPerUser.get(userKey);
    if (!existing || c.created_at < existing.created_at) {
      oldestPerUser.set(userKey, { id: c.id, created_at: c.created_at });
    }
  }
  const fairOrder = Array.from(oldestPerUser.values());
  // Fisher-Yates shuffle so concurrent workers don't all pick the same
  // user's head of line.
  for (let i = fairOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fairOrder[i], fairOrder[j]] = [fairOrder[j]!, fairOrder[i]!];
  }

  for (const candidate of fairOrder) {
    const { data: claimed } = await supabase
      .from("jobs")
      .update({
        status: "processing",
        claimed_at: new Date().toISOString(),
      })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle<QueueJob>();
    if (claimed) return claimed;
    // Lost the race — sibling worker grabbed this candidate. Try next.
  }

  return null;
}

/**
 * Claim ONE specific job by id (race-safe). Used by inline-run paths so
 * a route can drain the row it just inserted without waiting for the cron
 * tick.
 *
 * If the cron worker won the race in the gap between INSERT and this call,
 * returns null — the caller falls back to 202-and-poll.
 */
export async function claimSpecificJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<QueueJob | null> {
  const { data: claimed } = await supabase
    .from("jobs")
    .update({
      status: "processing",
      claimed_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle<QueueJob>();
  return claimed ?? null;
}
