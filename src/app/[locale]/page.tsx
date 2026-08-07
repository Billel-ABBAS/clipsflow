import { Languages, Mic, ShieldCheck } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function HomePage({
  params,
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");

  const features = [
    {
      icon: Languages,
      title: t("feature_dub_title"),
      description: t("feature_dub_desc"),
    },
    {
      icon: Mic,
      title: t("feature_clips_title"),
      description: t("feature_clips_desc"),
    },
    {
      icon: ShieldCheck,
      title: t("feature_consent_title"),
      description: t("feature_consent_desc"),
    },
  ] as const;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center gap-12 px-6 py-24">
      <section className="flex flex-col items-center gap-6 text-center">
        <Badge variant="secondary">{t("badge")}</Badge>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          {t("title")}
        </h1>
        <p className="text-muted-foreground max-w-xl text-lg text-balance">
          {t("subtitle")}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button size="lg">{t("cta_primary")}</Button>
          <Button size="lg" variant="outline">
            {t("cta_secondary")}
          </Button>
        </div>
      </section>

      <section className="w-full">
        <h2 className="sr-only">{t("features_title")}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {features.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <feature.icon
                  className="text-muted-foreground size-5"
                  aria-hidden
                />
                <CardTitle className="text-base">{feature.title}</CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
