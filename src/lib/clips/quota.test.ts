// ============================================================================
// Tests unitaires — quota.ts
// ============================================================================
// Mock Supabase via un chain-builder : objet fluent dont chaque méthode
// retourne `this` (ou une promesse) de sorte que les appels chaînés
// (.from().select().eq().single()) fonctionnent sans vraie DB.

import { describe, it, expect, vi } from "vitest";
import {
  checkClipAccess,
  refundClipSeconds,
  stripCustomizationsByPlan,
  REFUND_EXCLUDED_PREFIXES,
  QUOTAS_SECONDS,
} from "./quota";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRO_COLOR_PALETTE } from "./subtitle-styles";

// ---------------------------------------------------------------------------
// Chain-builder helper
// ---------------------------------------------------------------------------

type ChainResult<T = unknown> = {
  data: T | null;
  error: null | { message: string };
};

/**
 * Crée un mock Supabase minimaliste.
 * - `fromResult` : valeur retournée par `.single()` ou `.maybeSingle()`
 * - `rpcResult` : valeur retournée par `.rpc()`
 */
function makeSupabase(options: {
  profileData?: Record<string, unknown> | null;
  profileError?: { message: string } | null;
  rpcData?: boolean | null;
  rpcError?: { message: string } | null;
  refundError?: { message: string } | null;
}): SupabaseClient {
  const {
    profileData = null,
    profileError = null,
    rpcData = null,
    rpcError = null,
    refundError = null,
  } = options;

  // Chaîne pour le select profile
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: profileData,
      error: profileError,
    } satisfies ChainResult),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  let rpcCallCount = 0;

  const supabase = {
    from: vi.fn().mockReturnValue(chain),
    rpc: vi.fn().mockImplementation((name: string) => {
      rpcCallCount++;
      if (name === "clips_reserve_quota") {
        return Promise.resolve({ data: rpcData, error: rpcError });
      }
      if (name === "clips_refund_quota") {
        return Promise.resolve({ data: null, error: refundError });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    _rpcCallCount: () => rpcCallCount,
  } as unknown as SupabaseClient;

  return supabase;
}

// ---------------------------------------------------------------------------
// checkClipAccess
// ---------------------------------------------------------------------------
describe("checkClipAccess — allowed", () => {
  it("retourne allowed=true quand le RPC retourne true", async () => {
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 0 },
      rpcData: true,
    });
    const result = await checkClipAccess(sb, "user1", 60);
    expect(result.allowed).toBe(true);
  });

  it("calcule le remaining correctement", async () => {
    // plan=pro, limit=1800, used=100, seconds=60 → remaining=1800-100-60=1640
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 100 },
      rpcData: true,
    });
    const result = await checkClipAccess(sb, "user1", 60);
    expect(result.remaining).toBe(QUOTAS_SECONDS.pro - 100 - 60);
  });
});

describe("checkClipAccess — denied", () => {
  it("retourne allowed=false quand le RPC retourne false (quota dépassé)", async () => {
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 1800 },
      rpcData: false,
    });
    const result = await checkClipAccess(sb, "user1", 60);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("clip_quota_exceeded");
  });

  it("retourne allowed=false avec remaining=0 quand used >= limit", async () => {
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 1800 },
      rpcData: false,
    });
    const result = await checkClipAccess(sb, "user1", 60);
    expect(result.remaining).toBe(0);
  });

  it("fail-closed : erreur RPC → allowed=false", async () => {
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 0 },
      rpcError: { message: "connection refused" },
    });
    const result = await checkClipAccess(sb, "user1", 60);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("clip_quota_exceeded");
  });
});

describe("checkClipAccess — profile_not_found", () => {
  it("throw 'profile_not_found' si le profil est null", async () => {
    const sb = makeSupabase({ profileData: null });
    await expect(checkClipAccess(sb, "ghost-user", 60)).rejects.toThrow(
      "profile_not_found",
    );
  });
});

// ---------------------------------------------------------------------------
// refundClipSeconds — best-effort (ne throw jamais)
// ---------------------------------------------------------------------------
describe("refundClipSeconds", () => {
  it("ne throw pas sur succès", async () => {
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 60 },
      refundError: null,
    });
    await expect(refundClipSeconds(sb, "user1", 60)).resolves.toBeUndefined();
  });

  it("ne throw pas même si le RPC échoue", async () => {
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 60 },
      refundError: { message: "RPC failed" },
    });
    // Doit résoudre sans exception
    await expect(refundClipSeconds(sb, "user1", 60)).resolves.toBeUndefined();
  });

  it("appelle bien le RPC clips_refund_quota", async () => {
    const sb = makeSupabase({
      profileData: { id: "user1", clip_seconds_used_this_month: 60 },
    });
    await refundClipSeconds(sb, "user1", 30);
    expect(
      (sb as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc,
    ).toHaveBeenCalledWith(
      "clips_refund_quota",
      expect.objectContaining({ p_user_id: "user1", p_seconds: 30 }),
    );
  });
});

// ---------------------------------------------------------------------------
// REFUND_EXCLUDED_PREFIXES — contrat exact
// ---------------------------------------------------------------------------
describe("REFUND_EXCLUDED_PREFIXES", () => {
  it("contient exactement les 4 préfixes documentés", () => {
    const expected = [
      "invalid_job",
      "clip_not_found",
      "episode_not_found",
      "invalid_clip_status",
    ];
    expect([...REFUND_EXCLUDED_PREFIXES].sort()).toEqual(expected.sort());
  });

  it("n'inclut PAS les préfixes qui doivent déclencher un remboursement", () => {
    const shouldRefund = [
      "invalid_source_url",
      "source_download_failed",
      "whisper_failed",
      "subtitle_burn_failed",
      "upload_failed",
    ];
    for (const prefix of shouldRefund) {
      expect(REFUND_EXCLUDED_PREFIXES as readonly string[]).not.toContain(
        prefix,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// stripCustomizationsByPlan
// ---------------------------------------------------------------------------
describe("stripCustomizationsByPlan — free et solo", () => {
  it("free → {} (tout strippé)", () => {
    const result = stripCustomizationsByPlan("free", {
      text_color: "#FF0000",
      font: "Inter Bold",
      stroke_width: 5,
    });
    expect(result).toEqual({});
  });

  it("solo → {} (tout strippé, comportement identique à free)", () => {
    const result = stripCustomizationsByPlan("solo", {
      text_color: "#FF0000",
      font: "Inter Bold",
    });
    expect(result).toEqual({});
  });

  it("plan inconnu → {} (fail-closed)", () => {
    const result = stripCustomizationsByPlan("agency", {
      text_color: "#FF0000",
    });
    expect(result).toEqual({});
  });

  it("null → {} (fail-closed)", () => {
    expect(stripCustomizationsByPlan(null)).toEqual({});
  });
});

describe("stripCustomizationsByPlan — pro", () => {
  const paletteColor = PRO_COLOR_PALETTE[0]!; // "#FFD700"

  it("pro : garde text_color si dans la palette", () => {
    const result = stripCustomizationsByPlan("pro", {
      text_color: paletteColor,
    });
    expect(result.text_color).toBe(paletteColor);
  });

  it("pro : garde highlight_color si dans la palette", () => {
    const result = stripCustomizationsByPlan("pro", {
      highlight_color: paletteColor,
    });
    expect(result.highlight_color).toBe(paletteColor);
  });

  it("pro : supprime text_color hors palette", () => {
    const result = stripCustomizationsByPlan("pro", {
      text_color: "#AABBCC", // pas dans PRO_COLOR_PALETTE
    });
    expect(result.text_color).toBeUndefined();
  });

  it("pro : supprime les champs non-couleur (font, stroke_width...)", () => {
    const result = stripCustomizationsByPlan("pro", {
      text_color: paletteColor,
      font: "Inter Bold",
      stroke_width: 3,
      auto_emphasis: true,
    });
    expect(result.font).toBeUndefined();
    expect(result.stroke_width).toBeUndefined();
    expect(result.auto_emphasis).toBeUndefined();
  });
});

describe("stripCustomizationsByPlan — studio", () => {
  it("studio : garde tout ce qui est valide", () => {
    const result = stripCustomizationsByPlan("studio", {
      text_color: "#FF0000",
      font: "Inter Bold",
      stroke_width: 6,
      auto_emphasis: true,
      animation_speed: 1.5,
      position: "lower_third",
      position_y: 75,
    });
    expect(result.text_color).toBe("#FF0000");
    expect(result.font).toBe("Inter Bold");
    expect(result.stroke_width).toBe(6);
    expect(result.auto_emphasis).toBe(true);
    expect(result.animation_speed).toBe(1.5);
    expect(result.position).toBe("lower_third");
    expect(result.position_y).toBe(75);
  });

  it("studio : hex invalide → text_color undefined", () => {
    const result = stripCustomizationsByPlan("studio", {
      text_color: "not-a-hex",
    });
    expect(result.text_color).toBeUndefined();
  });

  it("studio : font hors CURATED_FONTS → undefined", () => {
    const result = stripCustomizationsByPlan("studio", {
      font: "Comic Sans MS",
    });
    expect(result.font).toBeUndefined();
  });

  it("studio : stroke_width clampé à [0, 12]", () => {
    expect(
      stripCustomizationsByPlan("studio", { stroke_width: -5 }).stroke_width,
    ).toBe(0);
    expect(
      stripCustomizationsByPlan("studio", { stroke_width: 99 }).stroke_width,
    ).toBe(12);
  });

  it("studio : animation_speed clampé à [0.5, 2.0]", () => {
    expect(
      stripCustomizationsByPlan("studio", { animation_speed: 0 })
        .animation_speed,
    ).toBe(0.5);
    expect(
      stripCustomizationsByPlan("studio", { animation_speed: 5 })
        .animation_speed,
    ).toBe(2);
  });

  it("studio : position invalide → undefined", () => {
    const result = stripCustomizationsByPlan("studio", {
      position: "invalid_pos" as never,
    });
    expect(result.position).toBeUndefined();
  });

  it("studio : emphasis_colors filtre les hex invalides et limite à 5", () => {
    const result = stripCustomizationsByPlan("studio", {
      emphasis_colors: [
        "#FF0000",
        "invalid",
        "#00FF00",
        "#0000FF",
        "#FFFF00",
        "#FF00FF",
        "#00FFFF", // 7ème → exclu
      ],
    });
    expect(result.emphasis_colors).toHaveLength(5);
    expect(result.emphasis_colors).not.toContain("invalid");
  });
});
