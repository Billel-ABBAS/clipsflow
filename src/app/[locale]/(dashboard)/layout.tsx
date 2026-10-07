// ============================================================================
// (dashboard) layout — minimal authenticated shell (P1).
// Server-side auth gate : no Supabase user → next-intl redirect to /login.
// Header : ClipsFlow brand (home link) + "Clips" nav + sign-out. The sonner
// <Toaster /> mounts here so every dashboard surface can toast.
// ============================================================================

import { getTranslations, setRequestLocale } from "next-intl/server";
import { headers } from "next/headers";
import { Plus } from "lucide-react";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { ClipsFlowBrand } from "@/components/ClipsFlowBrand";
import {
  DashboardSidebar,
  DashboardTopNavigation,
} from "@/components/DashboardNavigation";
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
  const requestHeaders = await headers();
  if (!user) {
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
  const newProjectHref = isShortsEnabled ? "/shorts" : "/clips/new";
  const navigationLabels = {
    mainNavigation: t("main_navigation"),
    workspaceSection: t("nav_workspace_section"),
    creationSection: t("nav_creation_section"),
    accountSection: t("nav_account_section"),
    dashboard: t("nav_dashboard"),
    library: t("nav_library"),
    createClip: t("nav_create_clip"),
    shorts: t("nav_shorts"),
    pricing: t("nav_pricing"),
    admin: t("nav_admin"),
  };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-border bg-background/95 sticky top-0 z-40 border-b backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-screen-2xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <ClipsFlowBrand href="/dashboard" />
          <DashboardTopNavigation
            labels={navigationLabels}
            isShortsEnabled={isShortsEnabled}
            isAdmin={isAdmin}
          />
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <Link
              href={newProjectHref}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors sm:px-3 sm:text-sm"
            >
              <Plus aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">{t("nav_new_project")}</span>
              <span className="sr-only sm:hidden">{t("nav_new_project")}</span>
            </Link>
            <SignOutButton label={t("sign_out")} />
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-screen-2xl flex-1">
        <DashboardSidebar
          labels={navigationLabels}
          isShortsEnabled={isShortsEnabled}
          isAdmin={isAdmin}
        />
        <main className="mx-auto w-full max-w-7xl min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
