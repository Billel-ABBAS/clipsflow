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
//   6. Quota : checkClipAccess réserve `end-start` secondes (402)
//   7. INSERT clips puis jobs — si l'insert jobs échoue APRÈS celui de
//      clips : refund + clips → failed (cohérence, pas de row orpheline
//      'pending' jamais drainée)
//   8. 202 { data: { clip_id, job_id, status: "pending" } }
//
// Réponses d'erreur : { error: string } (+ remaining sur 402).
// Status codes : 202 / 400 / 401 / 402 / 403 / 404 / 500.
// ============================================================================

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isClipsEnabled } from "@/lib/clips/feature-flag";
import {
  ASPECT_RATIOS,
  STYLE_KEYS,
  SUBTITLE_POSITIONS,
} from "@/lib/clips/types";
import {
  checkClipAccess,
  refundClipSeconds,
  resolvePlan,
  stripCustomizationsByPlan,
} from "@/lib/clips/quota";
import {
  validateOutboundUrl,
  OutboundUrlError,
} from "@/lib/security/validate-outbound-url";
import { routing } from "@/i18n/routing";

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
        validateOutboundUrl(s);
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
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }

  const admin = createAdminClient();

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

  // 6. Quota — réservation atomique de `end-start` secondes via le RPC
  // clips_reserve_quota (service_role only). À partir d'ICI, tout échec
  // avant le 202 doit refund (règle anti-double-refund : la réservation
  // vit au POST, le refund vit dans LE chemin qui constate l'échec).
  const durationSeconds = input.end_seconds - input.start_seconds;
  let access;
  try {
    access = await checkClipAccess(admin, user.id, durationSeconds);
  } catch {
    return NextResponse.json({ error: "profile_not_found" }, { status: 404 });
  }
  if (!access.allowed) {
    return NextResponse.json(
      { error: "quota_exceeded", remaining: access.remaining ?? 0 },
      { status: 402 },
    );
  }

  // 7a. INSERT clips (client user — RLS insert_own active).
  const { data: clip, error: clipErr } = await supabase
    .from("clips")
    .insert({
      episode_id: episodeId,
      user_id: user.id,
      start_seconds: input.start_seconds,
      end_seconds: input.end_seconds,
      style_key: input.style_key,
      aspect_ratio: input.aspect_ratio,
      language: input.language,
      customizations: allowedCustomizations,
      overlays: input.overlays ?? [],
      status: "pending",
    })
    .select("id")
    .single();
  if (clipErr || !clip) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-clips-jobs",
        message: "clips insert failed",
        error: clipErr?.message?.slice(0, 300),
      }),
    );
    // Quota réservé à l'étape 6 mais la row n'existe pas → refund.
    await refundClipSeconds(admin, user.id, durationSeconds);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }
  const clipId = clip.id as string;

  // 7b. INSERT jobs (queue). Si CET insert échoue après celui de clips :
  // refund + clips → failed, sinon la row 'pending' ne serait jamais
  // drainée et le quota resterait débité (cohérence).
  const { data: jobRow, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      type: "render",
      user_id: user.id,
      episode_id: episodeId,
      clip_id: clipId,
      payload: { clip_id: clipId },
      status: "pending",
    })
    .select("id")
    .single();
  if (jobErr || !jobRow) {
    console.error(
      JSON.stringify({
        level: "error",
        source: "api-clips-jobs",
        message: "jobs insert failed after clips insert",
        clip_id: clipId,
        error: jobErr?.message?.slice(0, 300),
      }),
    );
    await refundClipSeconds(admin, user.id, durationSeconds);
    // Best-effort : marque le clip failed pour que la galerie n'affiche
    // pas un 'pending' fantôme. Client user (RLS clips_update_own) — la row
    // appartient au user courant, pas besoin du service_role (review L3 E2).
    await supabase
      .from("clips")
      .update({
        status: "failed",
        error_message: "enqueue_failed: jobs insert failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", clipId);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  // 8. 202 — le cron process-clips draine la queue (≤ 60 s).
  return NextResponse.json(
    {
      data: {
        clip_id: clipId,
        job_id: jobRow.id as string,
        status: "pending",
      },
    },
    { status: 202 },
  );
}
