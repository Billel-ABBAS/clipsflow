/**
 * useClipJobStatus — Realtime status hook for ClipsFlow clip renders.
 *
 * Subscribes to a Supabase Realtime `postgres_changes` UPDATE channel on
 * the `clips` row (`id=eq.<clipId>`, channel `clips-job-<clipId>`). The
 * cron worker (/api/cron/process-clips) UPDATEs the row through
 * pending → processing → completed | failed ; we receive each event and
 * surface it through React state. Resolution is terminal on
 * 'completed' | 'failed'.
 *
 * Ported from VidiaFlow src/hooks/use-clip-job-status.ts. Adaptations :
 *   - table `clip_subtitle_jobs` → `clips` ; channel renamed
 *     `clip-job-<id>` → `clips-job-<id>`
 *   - seed fetch : the source hit GET /api/clipflow/jobs/[id] — ClipsFlow
 *     P1 has no GET route, so the seed is a direct supabase select on
 *     `clips` (RLS select_own scopes it to the owner)
 *   - NEW polling fallback : the same select re-runs every 5 s (cap
 *     6 min) so a dropped Realtime message (network blip, channel close)
 *     can't strand the UI — whichever signal lands first wins
 *   - status enum gains 'completing' (clips table CHECK constraint)
 *   - output_url → video_url (clips column name)
 *
 * Module split (kept from source) :
 *   - createClipJobStatusController : pure factory, no React. Takes a
 *     supabase-shaped channel factory + a fetchSeed function + onChange
 *     callback. Exported for unit tests.
 *   - useClipJobStatus : React hook wrapping the controller with
 *     useState + useEffect lifecycle. Wires the real supabase browser
 *     client.
 */

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/** Closed enum mirroring the DB CHECK constraint on clips.status + 'idle'. */
export type ClipJobStatus =
  | "idle"
  | "pending"
  | "processing"
  | "completing"
  | "completed"
  | "failed";

/** Reactive state surface returned by the hook. */
export interface ClipJobStatusState {
  status: ClipJobStatus;
  errorMessage: string | null;
  videoUrl: string | null;
}

const TERMINAL_STATUSES: ReadonlySet<ClipJobStatus> = new Set([
  "completed",
  "failed",
]);

/** Polling fallback cadence + cap. */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 6 * 60 * 1000;

/** Subset of the `clips` row we care about. */
interface SeedRow {
  status?: string | null;
  error_message?: string | null;
  video_url?: string | null;
}

/** Supabase Realtime UPDATE payload subset. */
interface RealtimeUpdatePayload {
  new?: {
    status?: string | null;
    error_message?: string | null;
    video_url?: string | null;
  };
}

/** Channel surface used by the controller. Matches Supabase's
 *  RealtimeChannel but typed loosely so tests can stub without pulling
 *  realtime-js types. */
export interface ClipJobChannel {
  on(
    event: "postgres_changes",
    filter: { event: string; schema: string; table: string; filter: string },
    callback: (payload: RealtimeUpdatePayload) => void,
  ): ClipJobChannel;
  subscribe(callback?: (status: string) => void): ClipJobChannel;
  unsubscribe(): Promise<"ok" | "timed out" | "error"> | unknown;
}

/** Minimal supabase client surface needed by the controller. */
export interface ClipJobSupabaseClient {
  channel(name: string): ClipJobChannel;
  removeChannel(
    channel: ClipJobChannel,
  ): Promise<"ok" | "timed out" | "error"> | unknown;
}

/** Options for the pure controller — exported for tests. */
export interface ClipJobStatusControllerOptions {
  clipId: string;
  supabase: ClipJobSupabaseClient;
  fetchSeed: (clipId: string) => Promise<SeedRow | null>;
  onChange: (state: ClipJobStatusState) => void;
  /** Injectable for tests — defaults to the module constants. */
  pollIntervalMs?: number;
  pollMaxMs?: number;
}

/** Lifecycle handle returned by the controller. */
export interface ClipJobStatusController {
  /** Tear down the channel + cancel polling. Idempotent. */
  unsubscribe: () => void;
  /** True once we've hit a terminal status (completed | failed). */
  isTerminal: () => boolean;
}

/** Coerce a raw status string from DB into our closed enum. Anything
 *  outside the five expected values falls back to 'pending' so the UI
 *  doesn't lock up if the schema drifts. */
function coerceStatus(raw: unknown): ClipJobStatus {
  if (
    raw === "pending" ||
    raw === "processing" ||
    raw === "completing" ||
    raw === "completed" ||
    raw === "failed"
  ) {
    return raw;
  }
  return "pending";
}

function rowToState(row: SeedRow): ClipJobStatusState {
  return {
    status: coerceStatus(row.status),
    errorMessage:
      typeof row.error_message === "string" ? row.error_message : null,
    videoUrl: typeof row.video_url === "string" ? row.video_url : null,
  };
}

/**
 * Pure controller — no React. Subscribes the channel, fires the seed
 * fetch, starts the 5 s polling fallback, and pushes state changes
 * through `onChange`. Tests instantiate this directly with a stub
 * channel + fetchSeed.
 *
 * Behaviour :
 *   1. Open channel `clips-job-<clipId>` filtered to `id=eq.<clipId>`.
 *   2. Fire seed fetch in parallel (race-window safety : a clip that
 *      terminates before the subscription handshake completes is
 *      surfaced by the seed instead of waiting for an event that will
 *      never come).
 *   3. Poll the same fetch every 5 s, capped at 6 min — fallback when a
 *      Realtime message is dropped.
 *   4. On terminal status (any signal) → onChange + auto-unsubscribe.
 */
export function createClipJobStatusController(
  opts: ClipJobStatusControllerOptions,
): ClipJobStatusController {
  const {
    clipId,
    supabase,
    fetchSeed,
    onChange,
    pollIntervalMs = POLL_INTERVAL_MS,
    pollMaxMs = POLL_MAX_MS,
  } = opts;

  let terminal = false;
  let teardownCalled = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();

  function handleRow(row: SeedRow | null | undefined): void {
    if (terminal || teardownCalled || !row) return;
    const next = rowToState(row);
    onChange(next);
    if (TERMINAL_STATUSES.has(next.status)) {
      terminal = true;
      teardown();
    }
  }

  const channel: ClipJobChannel = supabase
    .channel(`clips-job-${clipId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "clips",
        filter: `id=eq.${clipId}`,
      },
      (payload: RealtimeUpdatePayload) => {
        handleRow(payload?.new);
      },
    )
    .subscribe();

  // Seed fetch — runs in parallel with the subscription handshake.
  fetchSeed(clipId)
    .then((row) => handleRow(row))
    .catch(() => {
      // Best-effort seed — the subscription + polling are the primary
      // sources of truth. A transient read error here is fine.
    });

  // Polling fallback — every 5 s, cap 6 min. Cheap single-row select ;
  // stops at the cap so a permanently-stuck row doesn't poll forever
  // (the caller owns the user-facing timeout).
  pollTimer = setInterval(() => {
    if (terminal || teardownCalled) return;
    if (Date.now() - startedAt > pollMaxMs) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    fetchSeed(clipId)
      .then((row) => handleRow(row))
      .catch(() => {
        /* transient — next tick retries */
      });
  }, pollIntervalMs);

  function teardown(): void {
    if (teardownCalled) return;
    teardownCalled = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    try {
      // unsubscribe() returns a Promise in realtime-js v2 ; removeChannel()
      // is the recommended wrapper that also drops the client-side
      // reference. Call both — tests can spy on unsubscribe directly.
      const result = channel.unsubscribe();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch(() => {
          // realtime-js sometimes resolves 'timed out' on a disconnected
          // client — not a real error, ignore.
        });
      }
      supabase.removeChannel(channel);
    } catch {
      // Best-effort — the page is unmounting, swallow.
    }
  }

  return {
    unsubscribe: teardown,
    isTerminal: () => terminal,
  };
}

/**
 * React hook : subscribes to a `clips` row's status via Supabase
 * Realtime + seed fetch + 5 s polling fallback (cap 6 min).
 *
 * Returns reactive state — the consumer typically waits for
 * `status === 'completed' || status === 'failed'` then navigates /
 * surfaces an error.
 *
 * No-op when `clipId` is null / undefined : the caller computes the id
 * conditionally (only after the 202 response arrives) and the hook
 * ordering stays stable across renders.
 */
export function useClipJobStatus(
  clipId: string | null | undefined,
): ClipJobStatusState {
  const [state, setState] = useState<ClipJobStatusState>({
    status: "idle",
    errorMessage: null,
    videoUrl: null,
  });

  useEffect(() => {
    if (!clipId) return;

    // Reset to idle when the clipId changes — defensive against stale
    // state from a previous clip leaking into the new subscription.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "idle", errorMessage: null, videoUrl: null });

    const supabase = createClient();
    const controller = createClipJobStatusController({
      clipId,
      supabase: supabase as unknown as ClipJobSupabaseClient,
      fetchSeed: async (id) => {
        const { data } = await supabase
          .from("clips")
          .select("status, error_message, video_url")
          .eq("id", id)
          .maybeSingle();
        return (data as SeedRow | null) ?? null;
      },
      onChange: (next) => setState(next),
    });

    return () => {
      controller.unsubscribe();
    };
  }, [clipId]);

  return state;
}
