import { ArrowRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { ClipsFlowBrand } from "@/components/ClipsFlowBrand";
import { Link } from "@/i18n/navigation";

export async function MarketingHeader({
  locale,
  primaryLabel,
}: {
  locale: string;
  primaryLabel: string;
}) {
  const t = await getTranslations({ locale, namespace: "siteNav" });

  return (
    <header className="border-border/80 bg-background/95 sticky top-0 z-50 border-b backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <ClipsFlowBrand />
        <nav
          aria-label={t("main_navigation")}
          className="ml-auto flex items-center gap-2 sm:gap-5"
        >
          <Link
            href="/#features"
            className="text-muted-foreground hover:text-foreground hidden text-sm font-medium transition-colors md:inline-flex"
          >
            {t("features")}
          </Link>
          <Link
            href="/pricing"
            className="text-muted-foreground hover:text-foreground px-2 py-2 text-sm font-medium transition-colors"
          >
            {t("pricing")}
          </Link>
          <Link
            href="/login"
            className="text-muted-foreground hover:text-foreground hidden px-2 py-2 text-sm font-medium transition-colors sm:inline-flex"
          >
            {t("sign_in")}
          </Link>
          <Link
            href="/login?next=%2Fshorts"
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-semibold shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:px-4"
          >
            <span className="sm:hidden">{t("create_shorts_short")}</span>
            <span className="hidden sm:inline">{primaryLabel}</span>
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </nav>
      </div>
    </header>
  );
}
