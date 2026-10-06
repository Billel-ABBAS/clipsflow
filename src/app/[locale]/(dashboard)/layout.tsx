// ============================================================================
// (dashboard) layout — minimal authenticated shell (P1).
// Server-side auth gate : no Supabase user → next-intl redirect to /login.
// Header : ClipsFlow brand (home link) + "Clips" nav + sign-out. The sonner
// <Toaster /> mounts here so every dashboard surface can toast.
// ============================================================================

import { getTranslations, setRequestLocale } from "next-intl/server";
import { headers } from "next/headers";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { Toaster } from "@/components/ui/sonner";
import { Link, redirect } from "@/i18n/navigation";
import {
  AUTH_REQUEST_PATH_HEADER,
  getAuthReturnPathFromPathname,
} from "@/lib/auth/return-path";
import { isClipsEnabled } from "@/lib/clips/feature-flag";
import { hasAdminAccess } from "@/lib/security/admin-access";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  setRequestLocale(locale);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const requestHeaders = await headers();
    const next = getAuthReturnPathFromPathname(
      requestHeaders.get(AUTH_REQUEST_PATH_HEADER),
      locale,
    );
    return redirect({
      href: { pathname: "/login", query: { next } },
      locale,
    });
  }

  const isAdmin = hasAdminAccess(user);
  const isShortsEnabled = isClipsEnabled({ locale, userId: user.id });

  const t = await getTranslations("clips.shell");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-border border-b">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3 sm:gap-6">
            <Link
              href="/"
              className="text-foreground text-sm font-semibold whitespace-nowrap"
            >
              ClipsFlow
            </Link>
            <nav className="flex min-w-0 items-center gap-2 sm:gap-4">
              <Link
                href="/clips"
                className="text-muted-foreground hover:text-foreground text-xs whitespace-nowrap transition-colors sm:text-sm"
              >
                {t("nav_clips")}
              </Link>
              {isShortsEnabled ? (
                <Link
                  href="/shorts"
                  className="text-muted-foreground hover:text-foreground text-xs whitespace-nowrap transition-colors sm:text-sm"
                >
                  {t("nav_shorts")}
                </Link>
              ) : null}
              <Link
                href="/pricing"
                className="text-muted-foreground hover:text-foreground hidden text-sm whitespace-nowrap transition-colors sm:inline-flex"
              >
                {t("nav_pricing")}
              </Link>
              {isAdmin ? (
                <Link
                  href="/admin"
                  className="text-muted-foreground hover:text-foreground hidden text-sm whitespace-nowrap transition-colors sm:inline-flex"
                >
                  Admin
                </Link>
              ) : null}
            </nav>
          </div>
          <SignOutButton label={t("sign_out")} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
      <Toaster />
    </div>
  );
}
