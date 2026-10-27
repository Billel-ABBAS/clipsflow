import createIntlMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";

import { routing } from "@/i18n/routing";
import { AUTH_REQUEST_PATH_HEADER } from "@/lib/auth/return-path";
import { updateSession } from "@/lib/supabase/middleware";

// Next 16 : la convention `middleware.ts` est dépréciée et renommée `proxy.ts`
// (cf. node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
const intlMiddleware = createIntlMiddleware(routing);

export default async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(AUTH_REQUEST_PATH_HEADER, request.nextUrl.pathname);
  const requestWithPath = new NextRequest(request, { headers: requestHeaders });

  // Supabase actualise la requête avant sa transmission au rendu serveur.
  // La réponse finale reste celle de next-intl, avec ses locales et redirections.
  return updateSession(requestWithPath, intlMiddleware);
}

export const config = {
  // Tout sauf API routes, internals Next et fichiers statiques (avec extension)
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
