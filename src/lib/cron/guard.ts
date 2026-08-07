// ============================================================================
// ClipsFlow — cron auth guard (fail-CLOSED)
// ============================================================================
// Porté de VidiaFlow src/lib/api/cron-auth.ts (guardCronRequest, audit
// 2026-05-13 C3). Le pattern legacy `if (secret) { check }` fail-OPEN quand
// CRON_SECRET manque (deploy mal configuré, env var perdue après recréation
// du projet Vercel) : n'importe qui pourrait alors drainer
// /api/cron/process-clips 60×/min. Ce guard renvoie 401 quand le secret est
// absent OU quand le bearer ne matche pas.
//
// Exemption dev : NODE_ENV === 'development' sans secret → autorisé, pour
// que `pnpm dev` fonctionne sans configurer CRON_SECRET.
//
// Adaptations vs source : logger observabilité remplacé par un console.error
// JSON une-ligne (ClipsFlow n'a pas encore de module logger — même shim que
// run-job.ts) ; Sentry capture conservée fail-soft.
// ============================================================================

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

/**
 * Garde une route cron. Retourne `null` quand la requête est autorisée
 * (l'appelant continue son drain), ou une `NextResponse` 401 quand elle ne
 * l'est pas (l'appelant DOIT court-circuiter : `if (unauth) return unauth;`).
 *
 * @param request   La Request entrante (premier argument du handler).
 * @param routeName Identifiant court pour les logs + breadcrumbs Sentry.
 */
export function guardCronRequest(
  request: Request,
  routeName: string,
): NextResponse | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    // Exemption dev — workflow `pnpm dev` inchangé. Tout autre
    // environnement (preview / production) fail CLOSED.
    if (process.env.NODE_ENV === "development") {
      return null;
    }

    // Production / preview sans CRON_SECRET : misconfiguration de deploy,
    // pas une erreur utilisateur. Log fort + Sentry pour que l'on-call la
    // voie avant un attaquant.
    console.error(
      JSON.stringify({
        level: "error",
        source: "cron-guard",
        message: `CRON_SECRET missing in ${routeName}`,
      }),
    );
    try {
      Sentry.addBreadcrumb({
        category: "cron-guard",
        level: "error",
        message: `CRON_SECRET missing in ${routeName}`,
      });
      Sentry.captureMessage(`CRON_SECRET missing in ${routeName}`, "error");
    } catch {
      // Glitch SDK Sentry — ne jamais cascader dans le guard.
    }

    return NextResponse.json(
      { error: "Unauthorized: cron secret not configured" },
      { status: 401 },
    );
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
