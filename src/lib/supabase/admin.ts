// ============================================================================
// ClipsFlow — service-role Supabase admin client (SERVER ONLY)
// ============================================================================
// ⚠️ JAMAIS importé par du code client (composants, hooks, "use client").
// Le service_role bypasse la RLS — ce client est réservé aux route handlers
// API / cron qui ont DÉJÀ authentifié et autorisé l'appelant, et aux
// opérations que le client cookie-scoped ne peut pas faire :
//   - RPCs quota `clips_reserve_quota` / `clips_refund_quota` (GRANT
//     service_role only — voir 0002_clips_schema.sql)
//   - uploads vers le bucket `clip-outputs` (INSERT service_role only)
//   - lifecycle des rows `jobs` (UPDATE réservé au worker)
//
// Pattern porté de VidiaFlow src/lib/supabase/admin.ts (getServiceRoleClient,
// audit 2026-05-13 C3) en version simplifiée P1 :
//   - mémoïsation module-scope (un isolate Vercel chaud réutilise le pool
//     keep-alive au lieu de rouvrir un socket TLS par tick de cron)
//   - PAS de TTL ni de stub Realtime : la realtime-js livrée avec
//     @supabase/supabase-js ^2.108 ne probe plus eagerly le WebSocket natif
//     (le crash Node 20 "detected without native WebSocket support" du
//     pattern source est résolu upstream).
// ============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Retourne le client Supabase service_role mémoïsé.
 *
 * Throw explicite si `NEXT_PUBLIC_SUPABASE_URL` ou
 * `SUPABASE_SERVICE_ROLE_KEY` manquent — les routes cron / jobs en dépendent
 * et un client à moitié configuré échouerait silencieusement plus loin
 * (fail-fast au boot plutôt que fail-soft en plein drain).
 */
export function createAdminClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "createAdminClient: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
