import { routing } from "@/i18n/routing";

type Locale = (typeof routing.locales)[number];

export const AUTH_REQUEST_PATH_HEADER = "x-clipsflow-request-path";

function resolveAuthLocale(rawLocale: string): Locale {
  return routing.locales.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : routing.defaultLocale;
}

/** Destinations that can be resumed safely after authentication. */
export const AUTH_RETURN_PATHS = [
  "/dashboard",
  "/clips",
  "/clips/new",
  "/shorts",
] as const;

export type AuthReturnPath = (typeof AUTH_RETURN_PATHS)[number];

/**
 * Restrict post-auth navigation to known in-app destinations. Auth URLs are
 * browser-controlled, so accepting arbitrary relative paths is unnecessary.
 */
export function getSafeAuthReturnPath(
  raw: string | null | undefined,
): AuthReturnPath {
  if (
    raw === "/shorts" ||
    raw === "/clips/new" ||
    raw === "/clips" ||
    raw === "/dashboard"
  ) {
    return raw;
  }
  return "/dashboard";
}

/** Resolve the dashboard path saved by proxy.ts without trusting client input. */
export function getAuthReturnPathFromPathname(
  pathname: string | null | undefined,
  locale: string,
): AuthReturnPath {
  const localePrefix = `/${resolveAuthLocale(locale)}`;
  const unlocalizedPath = pathname?.startsWith(`${localePrefix}/`)
    ? pathname.slice(localePrefix.length)
    : pathname;

  return getSafeAuthReturnPath(unlocalizedPath);
}

/** Build the locale-prefixed destination persisted through the OAuth callback. */
export function getAuthCallbackPath(
  rawPath: string | null | undefined,
  locale: string,
): string {
  return `/${resolveAuthLocale(locale)}${getSafeAuthReturnPath(rawPath)}`;
}

/** Build the same-origin confirmation URL used after password signup. */
export function getAuthCallbackRedirectUrl(
  appOrigin: string,
  rawPath: string | null | undefined,
  locale: string,
): string {
  const callbackUrl = new URL("/api/auth/callback", appOrigin);
  callbackUrl.searchParams.set("next", getAuthCallbackPath(rawPath, locale));
  return callbackUrl.toString();
}
