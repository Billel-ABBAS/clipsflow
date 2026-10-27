import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Renouvelle les cookies de requête avant que next-intl construise les headers
 * transmis au rendu serveur. Les cookies navigateur sont ensuite ajoutés SUR
 * cette même réponse intl : ses locales et redirections restent intactes.
 */
export async function updateSession(
  request: NextRequest,
  createResponse: (request: NextRequest) => NextResponse,
): Promise<NextResponse> {
  if (!supabaseUrl || !supabaseAnonKey) return createResponse(request);

  const applyCookies: Array<(response: NextResponse) => void> = [];
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          // Les lectures suivantes et le rendu de CETTE requête voient le refresh.
          request.cookies.set(name, value);
          applyCookies.push((response) => {
            response.cookies.set(name, value, options);
          });
        }
      },
    },
  });

  // Conserve la vérification serveur de l'utilisateur et le refresh si nécessaire.
  await supabase.auth.getUser();

  const response = createResponse(request);
  for (const applyCookie of applyCookies) applyCookie(response);
  if (applyCookies.length > 0) {
    // Une réponse renouvelant une session ne doit pas être partagée par un cache.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");
  }
  return response;
}
