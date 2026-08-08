import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { PricingCards } from "@/components/pricing/PricingCards";
import { createClient } from "@/lib/supabase/server";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return {
    title: "ClipsFlow Pricing",
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

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center gap-12 px-6 py-24">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          {t("title")}
        </h1>
        <p className="text-muted-foreground mt-4 text-lg">
          {t("subtitle")}
        </p>
      </div>

      <PricingCards locale={locale} isLoggedIn={!!user} />

      <div className="mt-12 text-center text-sm text-muted-foreground">
        <p>{t("note")}</p>
      </div>
    </main>
  );
}
