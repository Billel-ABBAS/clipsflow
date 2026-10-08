import { getTranslations, setRequestLocale } from "next-intl/server";

import { PricingCards } from "@/components/pricing/PricingCards";
import { MarketingHeader } from "@/components/MarketingHeader";
import { PageHeading } from "@/components/ui/PageHeading";
import { createClient } from "@/lib/supabase/server";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pricing" });
  return {
    title: t("title"),
    description: t("subtitle"),
  };
}

export default async function PricingPage({
  params,
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  setRequestLocale(locale);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const t = await getTranslations("pricing");
  const nav = await getTranslations({ locale, namespace: "siteNav" });

  return (
    <>
      <MarketingHeader locale={locale} primaryLabel={nav("create_shorts")} />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-12 px-4 py-16 sm:px-6 sm:py-20">
        <PageHeading
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("subtitle")}
          alignment="center"
          titleSize="default"
        />

        <PricingCards locale={locale} isLoggedIn={!!user} />

        <div className="text-muted-foreground mt-12 text-center text-sm">
          <p>{t("quota_note")}</p>
          <p>{t("note")}</p>
        </div>
      </main>
    </>
  );
}
