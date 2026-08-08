// ============================================================================
// (dashboard) layout — minimal authenticated shell (P1).
// Server-side auth gate : no Supabase user → next-intl redirect to /login.
// Header : ClipsFlow brand (home link) + "Clips" nav + sign-out. The sonner
// <Toaster /> mounts here so every dashboard surface can toast.
// ============================================================================

import { getTranslations, setRequestLocale } from "next-intl/server";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { Toaster } from "@/components/ui/sonner";
import { Link, redirect } from "@/i18n/navigation";
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
    redirect({ href: "/login", locale });
  }

  const t = await getTranslations("clips.shell");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-border border-b">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-foreground text-sm font-semibold">
              ClipsFlow
            </Link>
            <nav className="flex items-center gap-4">
              <Link
                href="/clips"
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {t("nav_clips")}
              </Link>
              <Link
                href="/pricing"
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {t("nav_pricing")}
              </Link>
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
