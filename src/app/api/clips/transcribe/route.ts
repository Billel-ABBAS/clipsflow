// ============================================================================
// ClipsFlow Clips — POST /api/clips/transcribe (stateless Whisper)
// ============================================================================
// Endpoint de transcription léger : l'appelant passe une URL HTTPS signée,
// le serveur la fetch une fois via le helper Whisper et retourne words[] +
// langue auto-détectée. Aucune row insérée, aucun débit de quota (gate soft
// uniquement — court-circuite les users déjà over-quota avant de brûler des
// tokens Whisper).
//
// Port fidèle de VidiaFlow /api/clipflow/transcribe. Adaptations :
//   - imports/namespaces clipflow → clips
//   - checkSubtitleAccess(supabase, …, 0) → checkClipAccess(admin, …, 0) :
//     le RPC clips_reserve_quota est GRANT service_role only (0002), le
//     client cookie ne peut pas l'appeler. p_seconds=0 = réservation no-op,
//     refuse uniquement si le user est déjà au-delà de sa limite.
//   - flag off → 403 (cohérence Lot 3 ; la source renvoyait 503)
//   - captureError observability → Sentry direct fail-soft (ClipsFlow n'a
//     pas encore de module telemetry)
//
// Provider routing : transcribeWithWhisper choisit Groq Whisper Large v3
// Turbo quand GROQ_API_KEY est posée (216× temps réel, 9× moins cher),
// sinon OpenAI whisper-1. CLIPS_FORCE_OPENAI_WHISPER=1 force le fallback.
//
// Status codes : 200 / 400 / 401 / 402 / 403 / 404 / 422 / 500.
// ============================================================================

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { checkClipAccess } from "@/lib/clips/quota";
import {
  validateOutboundUrl,
  defaultClipsAllowedHosts,
  OutboundUrlError,
} from "@/lib/security/validate-outbound-url";
import { routing } from "@/i18n/routing";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";

export const runtime = "nodejs";
// Whisper Large v3 Turbo sur Groq répond en ~1 s pour un clip de 60 s.
// Le fallback OpenAI peut prendre 5-25 s. 30 s absorbe les deux.
export const maxDuration = 30;

const inputSchema = z.object({
  source_video_url: z.url().startsWith("https://", {
    message: "source_video_url must be HTTPS",
  }),
  language: z.string().min(2).max(10).optional(),
});

/** Sentry capture fail-soft — un glitch SDK ne doit jamais casser la route. */
function captureTranscribeError(err: unknown, userIdPrefix: string): void {
  try {
    Sentry.captureException(err, {
      tags: {
        feature: "clips",
        route: "api/clips/transcribe",
        user_id_prefix: userIdPrefix,
      },
    });
  } catch {
    // Sentry lui-même a échoué — ne pas cascader.
  }
}

export async function POST(request: Request): Promise<Response> {
  // 1. Cookie auth.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 1.5 Rate limit distribué : toutes les instances Vercel partagent le
  // compteur et une panne Postgres ferme l'accès aux crédits IA.
  const admin = createAdminClient();
  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `transcribe:${user.id}`,
      30,
      60,
    );
  } catch {
    return NextResponse.json(
      { error: "rate_limit_unavailable" },
      { status: 503 },
    );
  }
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": rateLimit.retryAfterSeconds.toString(),
        },
      },
    );
  }

  // 2. Feature flag (miroir /api/clips/jobs).
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (
    // Wrapper env (défaut dev = all quand CLIPS_ENABLED est vide) — review L3 E1.
    !isClipsEnabled({ locale, userId: user.id })
  ) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }

  // 3. Parse + validation.
  let parsed;
  try {
    const body = await request.json();
    parsed = inputSchema.safeParse(body);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // 3.5 SSRF guard (audit VidiaFlow CRIT-3) — sans ce check, un user
  // authentifié pourrait faire fetch()er `https://169.254.169.254/...`
  // (metadata cloud) par la lambda via Whisper. Hosts restreints à
  // l'allowlist Supabase Storage, comme le chemin cron.
  try {
    validateOutboundUrl(input.source_video_url, {
      allowedHosts: defaultClipsAllowedHosts(),
    });
  } catch (err) {
    if (err instanceof OutboundUrlError) {
      console.warn(
        JSON.stringify({
          level: "warn",
          source: "api-clips-transcribe",
          message: "source URL blocked by SSRF guard",
          user_id_prefix: user.id.slice(0, 8),
          reason: err.message.slice(0, 200),
        }),
      );
      return NextResponse.json(
        { error: "invalid_url", detail: err.message.slice(0, 200) },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  // 4. Gate quota soft (clipDuration=0 — la durée finale est inconnue à ce
  // stade, aucun débit ici). Empêche juste les users déjà 100 % over-quota
  // de brûler des tokens Whisper.
  let access;
  try {
    access = await checkClipAccess(admin, user.id, 0);
  } catch {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }
  if (!access.allowed) {
    return NextResponse.json(
      { error: "quota_exceeded", remaining: access.remaining ?? 0 },
      { status: 402 },
    );
  }

  // 5. Whisper. Import lazy pour garder le cold-start lean (le SDK openai
  // tire un graphe transitif non trivial). Le param `language` n'est
  // volontairement PAS forwardé — l'auto-detect Whisper couvre 99 % des
  // cas et le mapping BCP-47 → nom Whisper vit dans run-job.ts.
  try {
    const { transcribeWithWhisper } = await import("@/lib/clips/whisper");
    const result = await transcribeWithWhisper(
      input.source_video_url,
      undefined,
      undefined,
      undefined,
      defaultClipsAllowedHosts(),
    );
    // Guard words vide — miroir du fix cron VidiaFlow PR #408. Renvoyer
    // {words: []} laisserait l'appelant produire un clip sans sous-titres
    // (no-op silencieux). 422 → l'UI affiche un toast actionnable.
    if (result.words.length === 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          source: "api-clips-transcribe",
          message: "no_speech_detected",
          user_id: user.id,
        }),
      );
      return NextResponse.json(
        {
          error: "no_speech_detected",
          message:
            "Whisper returned 0 words. Source likely has no detectable speech (music-only, silent track, or unsupported audio language).",
        },
        { status: 422 },
      );
    }
    return NextResponse.json(
      {
        data: {
          words: result.words,
          detected_language: result.detectedLanguage,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-clips-transcribe",
        message: "whisper failed",
        user_id: user.id,
        error: errMsg.slice(0, 400),
      }),
    );
    captureTranscribeError(err, user.id.slice(0, 8));
    return NextResponse.json(
      { error: "whisper_failed", detail: errMsg.slice(0, 200) },
      { status: 500 },
    );
  }
}
