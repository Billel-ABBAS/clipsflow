import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Rafraîchit la session Supabase en posant les cookies SUR la réponse
 * next-intl déjà construite — jamais l'inverse. Écraser la réponse intl
 * ferait perdre ses headers x-middleware-* (leçon VidiaFlow PR #43 :
 * useLocale() retournait toujours la defaultLocale).
 *
 * No-op tant que les env vars Supabase ne sont pas définies (Phase 0 :
 * projet Supabase pas encore créé) — dev/build restent verts.
 */
export async function updateSession(
  request: NextRequest,
  response: NextResponse,
): Promise<NextResponse> {
  if (!supabaseUrl || !supabaseAnonKey) return response;

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Déclenche le refresh token si nécessaire (pose les cookies via setAll).
  await supabase.auth.getUser();

  return response;
}
