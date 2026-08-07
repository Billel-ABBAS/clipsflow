import createIntlMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";

import { routing } from "@/i18n/routing";
import { updateSession } from "@/lib/supabase/middleware";

// Next 16 : la convention `middleware.ts` est dépréciée et renommée `proxy.ts`
// (cf. node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
const intlMiddleware = createIntlMiddleware(routing);

export default async function proxy(request: NextRequest) {
  // 1. next-intl : normalise /pricing → /en/pricing (redirect/rewrite + headers locale)
  const response = intlMiddleware(request);

  // 2. Supabase : layer les cookies de session SUR la réponse intl (ordre critique)
  return updateSession(request, response);
}

export const config = {
  // Tout sauf API routes, internals Next et fichiers statiques (avec extension)
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
