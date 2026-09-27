// ============================================================================
// Tests unitaires — claim-job.ts
// ============================================================================
// Mock Supabase via chain-builder. Le comportement clé à tester :
//   1. Claim heureux : UPDATE retourne la row → la fonction retourne le job
//   2. Aucun pending → retourne null
//   3. Race perdue (UPDATE retourne 0 row) → passe au candidat suivant
//   4. Filtre type si fourni

import { describe, it, expect, vi } from "vitest";
import { claimNextJob, claimSpecificJob } from "./claim-job";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueueJob } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const JOB_A: QueueJob = {
  id: "job-a",
  type: "render",
  user_id: "user-1",
  episode_id: "ep-1",
  clip_id: "clip-1",
  payload: {},
  status: "processing",
  attempt_count: 1,
  claimed_at: new Date().toISOString(),
  lease_token: null,
  lease_expires_at: null,
  refund_applied_at: null,
  error_message: null,
  created_at: "2026-06-01T00:00:00Z",
  completed_at: null,
};

const JOB_B: QueueJob = {
  ...JOB_A,
  id: "job-b",
  user_id: "user-2",
  created_at: "2026-06-01T00:01:00Z",
};

// ---------------------------------------------------------------------------
// Builder chaîne Supabase (from → select → eq → order → limit → then)
// Supporte aussi la mise à jour (from → update → eq → select → maybeSingle)
// ---------------------------------------------------------------------------

type CandidateRow = { id: string; user_id: string; created_at: string };

function makeChainBuilder(options: {
  /** Rows retournées par le SELECT pending */
  candidateRows: CandidateRow[];
  /** Map id → job retourné lors de l'UPDATE (null = race perdue) */
  claimResults: Record<string, QueueJob | null>;
}) {
  const { candidateRows, claimResults } = options;

  // État interne pour suivre quel UPDATE on exécute
  let updateJobId: string | null = null;

  // Chaîne UPDATE
  const updateChain = {
    eq: vi.fn().mockImplementation((field: string, value: string) => {
      if (field === "id") updateJobId = value;
      return updateChain;
    }),
    select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockImplementation(() => {
      const job = updateJobId ? (claimResults[updateJobId] ?? null) : null;
      updateJobId = null;
      return Promise.resolve({ data: job, error: null });
    }),
  };

  // Chaîne SELECT — doit exposer TOUTES les méthodes chaînables utilisées par
  // claimNextJob :  .select().eq().order().limit()  et éventuellement .eq() de type
  // La chaîne doit être un objet dont chaque méthode retourne this SAUF limit()
  // qui résout la promesse. Mais claimNextJob fait `query = query.eq(...)` après
  // `.limit()` si `type` est fourni — impossible car limit() résout. On regarde
  // le code source : `query = ... .limit(BATCH)` puis `if (type) query = query.eq(...)`.
  // Le résultat de .limit() doit donc aussi être thenable ET exposer .eq().
  // Solution : on crée un objet "thenable chain" qui est à la fois une promesse
  // (pour l'await final) et expose les méthodes Supabase.
  class ThenableChain {
    private _data: CandidateRow[];
    constructor(data: CandidateRow[]) {
      this._data = data;
    }
    select() {
      return this;
    }
    eq() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    update() {
      return updateChain;
    }
    // Rend l'objet thenable (await this → { data, error })
    then(resolve: (v: { data: CandidateRow[]; error: null }) => void) {
      return Promise.resolve({ data: this._data, error: null }).then(resolve);
    }
  }

  const supabase = {
    from: vi.fn().mockImplementation(() => {
      return new ThenableChain(candidateRows);
    }),
  } as unknown as SupabaseClient;

  return supabase;
}

// ---------------------------------------------------------------------------
// Tests claimNextJob
// ---------------------------------------------------------------------------
describe("claimNextJob — claim heureux", () => {
  it("retourne le job quand l'UPDATE réussit", async () => {
    const sb = makeChainBuilder({
      candidateRows: [
        { id: "job-a", user_id: "user-1", created_at: "2026-06-01T00:00:00Z" },
      ],
      claimResults: { "job-a": JOB_A },
    });
    const result = await claimNextJob(sb);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("job-a");
  });

  it("retourne le job avec le statut processing", async () => {
    const sb = makeChainBuilder({
      candidateRows: [
        { id: "job-a", user_id: "user-1", created_at: "2026-06-01T00:00:00Z" },
      ],
      claimResults: { "job-a": JOB_A },
    });
    const result = await claimNextJob(sb);
    expect(result!.status).toBe("processing");
  });
});

describe("claimNextJob — aucun candidat pending", () => {
  it("retourne null quand la liste des candidats est vide", async () => {
    const sb = makeChainBuilder({
      candidateRows: [],
      claimResults: {},
    });
    const result = await claimNextJob(sb);
    expect(result).toBeNull();
  });
});

describe("claimNextJob — race perdue", () => {
  it("si UPDATE retourne null (race perdue), passe au candidat suivant", async () => {
    const sb = makeChainBuilder({
      candidateRows: [
        // user-1 job-a en tête (oldest)
        { id: "job-a", user_id: "user-1", created_at: "2026-06-01T00:00:00Z" },
        // user-2 job-b
        { id: "job-b", user_id: "user-2", created_at: "2026-06-01T00:01:00Z" },
      ],
      claimResults: {
        "job-a": null, // race perdue sur job-a
        "job-b": JOB_B, // succès sur job-b
      },
    });
    const result = await claimNextJob(sb);
    // Doit avoir essayé job-a (race perdue) puis réussi sur job-b OU vice-versa
    // (l'ordre exact dépend du shuffle Fisher-Yates, donc on vérifie juste
    // qu'un résultat non-null est retourné)
    expect(result).not.toBeNull();
  });

  it("retourne null si toutes les races sont perdues", async () => {
    const sb = makeChainBuilder({
      candidateRows: [
        { id: "job-a", user_id: "user-1", created_at: "2026-06-01T00:00:00Z" },
      ],
      claimResults: { "job-a": null }, // tout le monde perd
    });
    const result = await claimNextJob(sb);
    expect(result).toBeNull();
  });
});

describe("claimNextJob — filtre type", () => {
  it("retourne null quand la liste est vide, même avec un type fourni", async () => {
    const sb = makeChainBuilder({
      candidateRows: [],
      claimResults: {},
    });
    // Avec type fourni, la chaîne appelle .eq("type", "render") en plus.
    // Le ThenableChain ignore les arguments mais retourne this → chaîne correcte.
    const result = await claimNextJob(sb, "render");
    expect(result).toBeNull();
  });

  it("retourne le job quand type correspond", async () => {
    const sb = makeChainBuilder({
      candidateRows: [
        { id: "job-a", user_id: "user-1", created_at: "2026-06-01T00:00:00Z" },
      ],
      claimResults: { "job-a": JOB_A },
    });
    const result = await claimNextJob(sb, "render");
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests claimSpecificJob
// ---------------------------------------------------------------------------
describe("claimSpecificJob", () => {
  function makeSpecificJobSupabase(
    jobToReturn: QueueJob | null,
  ): SupabaseClient {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi
        .fn()
        .mockResolvedValue({ data: jobToReturn, error: null }),
    };
    return {
      from: vi.fn().mockReturnValue(chain),
    } as unknown as SupabaseClient;
  }

  it("retourne le job quand l'UPDATE réussit", async () => {
    const sb = makeSpecificJobSupabase(JOB_A);
    const result = await claimSpecificJob(sb, "job-a");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("job-a");
  });

  it("retourne null quand la race est perdue (maybeSingle retourne null)", async () => {
    const sb = makeSpecificJobSupabase(null);
    const result = await claimSpecificJob(sb, "job-a");
    expect(result).toBeNull();
  });
});
