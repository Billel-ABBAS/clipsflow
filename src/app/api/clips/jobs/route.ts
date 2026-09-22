// ============================================================================
// ClipsFlow Clips — POST /api/clips/jobs (création clip + enqueue)
// ============================================================================
// Crée une row `clips` (status 'pending') + une row `jobs` (type 'render')
// et répond 202. Le cron /api/cron/process-clips draine la queue (1 job/min).
//
// ⚠️ DÉVIATION vs SOURCE (VidiaFlow /api/clipflow/subtitle, PR #325) : la
// source drainait INLINE la row qu'elle venait d'insérer (claimSpecificJob +
// runSubtitleJob dans la même lambda, maxDuration 300). ClipsFlow P1 n'a PAS
// de chemin inline-run — le cron est l'unique worker. Conséquences :
//   - maxDuration 30 (la route ne fait que valider + insérer)
//   - latence perçue +0-60 s (tick cron) — acceptable P1, l'inline-run
//     pourra être ré-introduit en P2 sans casser ce contrat (la réponse
//     est déjà 202 + polling).
//
// Flow :
//   1. Cookie auth (401)
//   2. Feature flag CLIPS_ENABLED (403)
//   3. Body Zod strict (400)
//   4. Résolution source : episode_id OWN (404) XOR source.url
//      (SSRF guard 400 → row episodes créée via service_role)
//   5. stripCustomizationsByPlan AVANT insert (fail-closed par plan)
//   6. RPC transactionnelle service_role : vérifie propriétaire + quota,
//      réserve les secondes et crée clips + jobs sans état partiel (402)
//   7. 202 { data: { clip_id, job_id, status: "pending" } }
//
// Réponses d'erreur : { error: string } (+ remaining sur 402).
// Status codes : 202 / 400 / 401 / 402 / 403 / 404 / 500.
// ============================================================================

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isClipsEnabled, isClipsWorkerEnabled } from "@/lib/clips/feature-flag";
import {
  ASPECT_RATIOS,
  STYLE_KEYS,
  SUBTITLE_POSITIONS,
} from "@/lib/clips/types";
import { resolvePlan, stripCustomizationsByPlan } from "@/lib/clips/quota";
import { SubmitClipJobError, submitClipJob } from "@/lib/clips/submit-job";
import {
  validateOutboundUrl,
  defaultClipsAllowedHosts,
  OutboundUrlError,
} from "@/lib/security/validate-outbound-url";
import { routing } from "@/i18n/routing";
import { checkDistributedRateLimit } from "@/lib/rate-limit-distributed";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Cap dur sur la fenêtre du clip — DOIT rester aligné sur
 * MAX_SEGMENT_SECONDS dans run-job.ts (le pipeline rejette au-delà avec
 * `segment_too_long:` ; valider ici évite de réserver du quota pour un
 * job condamné).
 */
const MAX_CLIP_SECONDS = 180;

// Hex strict #RRGGBB — même contrat que le pipeline hex→ASS (audit
// VidiaFlow H4 : tout autre format devenait silencieusement des zéros).
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ----------------------------------------------------------------------------
// Customizations — schema repris de la route SOURCE (bounds identiques).
// ⚠️ Leçon VidiaFlow PR #370 : ce schema strict DOIT couvrir TOUS les champs
// de `SubtitleCustomizations` (types.ts) — un champ absent est silencieusement
// droppé AVANT stripCustomizationsByPlan et le user paie pour un no-op.
// Couverture champ par champ (13/13) :
//   text_color, highlight_color, background_color, background_opacity,
//   font, font_size, position, position_y, emojis_auto, stroke_width,
//   auto_emphasis, animation_speed, emphasis_colors.
// ----------------------------------------------------------------------------
const customizationsSchema = z.strictObject({
  text_color: z.string().regex(HEX_COLOR_RE).optional(),
  highlight_color: z.string().regex(HEX_COLOR_RE).optional(),
  background_color: z.string().regex(HEX_COLOR_RE).optional(),
  background_opacity: z.number().min(0).max(100).optional(),
  // Nom de famille de police — longueur cappée pour éviter un blowup du
  // fichier ASS.
  font: z.string().min(1).max(80).optional(),
  font_size: z.enum(["small", "medium", "large"]).optional(),
  position: z.enum(SUBTITLE_POSITIONS).optional(),
  position_y: z.number().min(0).max(100).optional(),
  emojis_auto: z.boolean().optional(),
  stroke_width: z.number().min(0).max(12).optional(),
  auto_emphasis: z.boolean().optional(),
  animation_speed: z.number().min(0.5).max(2).optional(),
  emphasis_colors: z.array(z.string().regex(HEX_COLOR_RE)).max(5).optional(),
});

// ----------------------------------------------------------------------------
// Overlays — schemas repris de la route SOURCE, miroir de la discriminated
// union de src/lib/clips/overlays.ts (source of truth runtime). Garder les
// deux en sync (caps de longueur + champs optionnels).
// ----------------------------------------------------------------------------
const titleCardOverlaySchema = z.object({
  type: z.literal("title_card"),
  text: z.string().min(1).max(60),
  subtitle: z.string().max(80).optional(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  font: z.string().max(40).optional(),
  color: z.string().max(7).optional(),
});

const lowerThirdOverlaySchema = z.object({
  type: z.literal("lower_third"),
  name: z.string().min(1).max(40),
  role: z.string().max(40).optional(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  slideInMs: z.number().min(0).max(2000).optional(),
});

const logoRevealOverlaySchema = z.object({
  type: z.literal("logo_reveal"),
  // SSRF guard à l'edge API (audit VidiaFlow H3) : sans ce refine, une URL
  // `https://169.254.169.254/x.png` serait fetch()ée par le worker depuis
  // la lambda. Bloquer ici = l'URL malicieuse n'enqueue même pas.
  logoUrl: z.url().refine(
    (s) => {
      try {
        validateOutboundUrl(s, { allowedHosts: defaultClipsAllowedHosts() });
        return true;
      } catch {
        return false;
      }
    },
    {
      message: "logoUrl must be a public HTTPS URL (no private/loopback hosts)",
    },
  ),
  position: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
    .optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  heightPx: z.number().min(20).max(400).optional(),
  fadeInMs: z.number().min(0).max(2000).optional(),
});

const statCalloutOverlaySchema = z.object({
  type: z.literal("stat_callout"),
  value: z.string().min(1).max(20),
  label: z.string().max(40).optional(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  position: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"])
    .optional(),
  color: z.string().max(7).optional(),
});

const ctaOutroOverlaySchema = z.object({
  type: z.literal("cta_outro"),
  text: z.string().min(1).max(60),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});

const overlayElementSchema = z.discriminatedUnion("type", [
  titleCardOverlaySchema,
  lowerThirdOverlaySchema,
  logoRevealOverlaySchema,
  statCalloutOverlaySchema,
  ctaOutroOverlaySchema,
]);

// ----------------------------------------------------------------------------
// Body — strict : tout champ inconnu est rejeté (pas de strip silencieux).
// ----------------------------------------------------------------------------
const bodySchema = z
  .strictObject({
    // SOIT un épisode existant (own, RLS)…
    episode_id: z.uuid().optional(),
    // …SOIT une source URL externe (une row episodes est créée).
    source: z
      .strictObject({
        url: z.url().startsWith("https://"),
        title: z.string().min(1).max(200),
      })
      .optional(),
    start_seconds: z.number().int().min(0),
    end_seconds: z.number().int().positive(),
    style_key: z.enum(STYLE_KEYS),
    aspect_ratio: z.enum(ASPECT_RATIOS),
    // BCP-47 light ("fr", "pt-BR", "auto" accepté comme sentinelle
    // run-job "garde la langue détectée").
    language: z.string().min(2).max(12),
    customizations: customizationsSchema.optional(),
    overlays: z.array(overlayElementSchema).max(4).optional(),
  })
  .refine((d) => (d.episode_id != null) !== (d.source != null), {
    message: "Provide exactly one of episode_id or source",
    path: ["episode_id"],
  })
  .refine((d) => d.end_seconds > d.start_seconds, {
    message: "end_seconds must be greater than start_seconds",
    path: ["end_seconds"],
  })
  .refine((d) => d.end_seconds - d.start_seconds <= MAX_CLIP_SECONDS, {
    message: `Clip window must be at most ${MAX_CLIP_SECONDS} seconds`,
    path: ["end_seconds"],
  });

export async function POST(request: Request): Promise<Response> {
  // 1. Cookie auth (userId requis pour le flag user-scoped ci-dessous).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  let rateLimit;
  try {
    rateLimit = await checkDistributedRateLimit(
      admin,
      `jobs:${user.id}`,
      10,
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

  // 2. Feature flag — locale lue du cookie next-intl (les routes /api sont
  // hors matcher du proxy : pas de header locale, le cookie posé par les
  // navigations de pages fait foi, fallback defaultLocale).
  const cookieStore = await cookies();
  const locale = cookieStore.get("NEXT_LOCALE")?.value ?? routing.defaultLocale;
  if (
    // Wrapper env (défaut dev = all quand CLIPS_ENABLED est vide) — review L3 E1.
    !isClipsEnabled({ locale, userId: user.id })
  ) {
    return NextResponse.json({ error: "not_yet_available" }, { status: 403 });
  }

  // The product can remain visible while rendering is deliberately paused
  // (staging, maintenance, or Railway budget protection).  Fail before a
  // source row or quota reservation is created, and make the five-minute
  // Railway cadence explicit to the caller.
  if (!isClipsWorkerEnabled()) {
    return NextResponse.json(
      {
        error: "rendering_temporarily_unavailable",
        retry_after_seconds: 300,
      },
      {
        status: 503,
        headers: { "Retry-After": "300" },
      },
    );
  }

  // 3. Parse + validation stricte du body.
  let parsed;
  try {
    const body = await request.json();
    parsed = bodySchema.safeParse(body);
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

  // Profil — requis par resolvePlan (constant 'pro' en P1, colonne réelle
  // en P3 : le call site ne changera pas) et fail-fast avant de créer une
  // row episodes orpheline si le profil a disparu.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, plan")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }

  // 4. Résolution de l'épisode source.
  let episodeId: string;
  if (input.source) {
    // SSRF guard sur l'URL externe AVANT toute persistance — hosts
    // privés / loopback / metadata / non-HTTPS rejetés.
    try {
      validateOutboundUrl(input.source.url);
    } catch (err) {
      if (err instanceof OutboundUrlError) {
        return NextResponse.json(
          { error: "invalid_url", detail: err.message.slice(0, 200) },
          { status: 400 },
        );
      }
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    // Row episodes via service_role (status 'ready' : la source est une
    // URL directe, rien à transcoder avant le render).
    const { data: episode, error: epErr } = await admin
      .from("episodes")
      .insert({
        user_id: user.id,
        title: input.source.title,
        source_type: "url",
        source_url: input.source.url,
        status: "ready",
      })
      .select("id")
      .single();
    if (epErr || !episode) {
      console.error(
        JSON.stringify({
          level: "error",
          source: "api-clips-jobs",
          message: "episode insert failed",
          error: epErr?.message?.slice(0, 300),
        }),
      );
      return NextResponse.json(
        { error: "episode_create_failed" },
        { status: 500 },
      );
    }
    episodeId = episode.id as string;
  } else {
    // Épisode existant — client user (RLS scope ownership) + .eq user_id
    // explicite (defence-in-depth si la policy évolue).
    const { data: episode } = await supabase
      .from("episodes")
      .select("id")
      .eq("id", input.episode_id!)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!episode) {
      return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
    }
    episodeId = episode.id as string;
  }

  // 5. Strip des customizations par plan AVANT insert (fail-closed : un
  // plan inconnu lock tout aux défauts du style).
  const plan = resolvePlan(profile);
  const allowedCustomizations = stripCustomizationsByPlan(
    plan,
    input.customizations,
  );

  // 6. La réservation de quota et les deux INSERT sont une seule unité
  // transactionnelle Postgres. Aucun état partiel n'est observable et le
  // navigateur n'a plus de privilège INSERT/UPDATE sur ces tables.
  let submitted;
  try {
    submitted = await submitClipJob(admin, {
      userId: user.id,
      episodeId,
      startSeconds: input.start_seconds,
      endSeconds: input.end_seconds,
      styleKey: input.style_key,
      aspectRatio: input.aspect_ratio,
      language: input.language,
      customizations: allowedCustomizations,
      overlays: input.overlays ?? [],
    });
  } catch (error) {
    if (error instanceof SubmitClipJobError) {
      if (error.code === "quota_exceeded") {
        return NextResponse.json(
          { error: "quota_exceeded", remaining: error.remaining ?? 0 },
          { status: 402 },
        );
      }
      if (error.code === "episode_not_found") {
        return NextResponse.json(
          { error: "episode_not_found" },
          { status: 404 },
        );
      }
      if (error.code === "profile_not_found") {
        return NextResponse.json(
          { error: "profile_not_found" },
          { status: 404 },
        );
      }
    }
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-clips-jobs",
        message: "transactional submit failed",
      }),
    );
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  // 7. 202 — le cron process-clips draine la queue (≤ 60 s).
  return NextResponse.json(
    {
      data: {
        clip_id: submitted.clipId,
        job_id: submitted.jobId,
        status: "pending",
      },
    },
    { status: 202 },
  );
}
