import { ArrowRight, Check, Scissors, Subtitles, Zap } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
      icon: Scissors,
      title: t("feature_clips_title"),
      description: t("feature_clips_desc"),
      color: "text-cyan-600",
    },
    {
      icon: Subtitles,
      title: t("feature_dub_title"),
      description: t("feature_dub_desc"),
      color: "text-violet-600",
    },
    {
      icon: Zap,
      title: t("feature_consent_title"),
      description: t("feature_consent_desc"),
      color: "text-amber-600",
    },
  ];

  const howItWorks = [
    { step: "1", title: t("step1_title"), desc: t("step1_desc") },
    { step: "2", title: t("step2_title"), desc: t("step2_desc") },
    { step: "3", title: t("step3_title"), desc: t("step3_desc") },
  ];

  return (
    <main className="bg-background text-foreground min-h-screen">
      {/* ── NAVIGATION ───────────────────────────────────────────────────── */}
      <header className="border-border/40 bg-background/80 sticky top-0 z-50 border-b backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href={`/${locale}`} className="text-lg font-bold">
            ClipsFlow
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href={`/${locale}/pricing`}
              className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
            >
              Pricing
            </Link>
            <Link
              href={`/${locale}/login`}
              className="text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
            >
              Sign in
            </Link>
            <Link
              href={`/${locale}/login`}
              className="bg-primary text-primary-foreground hover:bg-primary/80 inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors"
            >
              {t("cta_primary")}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </nav>
        </div>
      </header>

      {/* ── HERO ──────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-4 py-24 sm:px-6 sm:py-32">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/4 h-96 w-96 rounded-full bg-violet-500/15 blur-3xl" />
          <div className="absolute top-1/4 right-1/4 h-96 w-96 rounded-full bg-cyan-500/15 blur-3xl" />
        </div>

        <div className="mx-auto max-w-4xl text-center">
          <Badge variant="secondary" className="mb-6 gap-1.5">
            <span className="size-1.5 rounded-full bg-green-500" />
            {t("badge")}
          </Badge>

          <h1 className="text-foreground text-5xl font-bold tracking-tight sm:text-7xl">
            {t("hero_part1")}{" "}
            <span className="bg-gradient-to-r from-violet-600 to-cyan-600 bg-clip-text text-transparent">
              {t("hero_highlight")}
            </span>{" "}
            {t("hero_part2")}
          </h1>

          <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-lg leading-8">
            {t("subtitle")}
          </p>

          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href={`/${locale}/login`}
              className="group bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center rounded-md px-8 text-sm font-medium shadow transition-colors focus-visible:outline-none"
            >
              {t("cta_primary")}
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
            <a
              href="#how-it-works"
              className="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-10 items-center justify-center rounded-md border px-8 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none"
            >
              {t("cta_secondary")}
            </a>
          </div>

          <p className="text-muted-foreground mt-8 text-sm">
            {t("social_proof")}
          </p>
        </div>
      </section>

      {/* ── FEATURES ──────────────────────────────────────────────────────── */}
      <section className="px-4 py-24 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="text-center">
            <h2 className="text-foreground text-3xl font-bold tracking-tight sm:text-4xl">
              {t("features_title")}
            </h2>
            <p className="text-muted-foreground mt-4 text-lg">
              {t("features_subtitle")}
            </p>
          </div>

          <div className="mt-16 grid gap-8 sm:grid-cols-3">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="border-border/50 bg-card/50 backdrop-blur"
              >
                <CardHeader>
                  <div
                    className={cn(
                      "bg-muted mb-4 inline-flex size-10 items-center justify-center rounded-lg",
                      feature.color,
                    )}
                  >
                    <feature.icon className="size-5" />
                  </div>
                  <CardTitle className="text-xl">{feature.title}</CardTitle>
                  <CardDescription className="text-base">
                    {feature.description}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        className="border-border/40 bg-muted/30 border-t px-4 py-24 sm:px-6"
      >
        <div className="mx-auto max-w-7xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              {t("how_it_works_title")}
            </h2>
          </div>

          <div className="mt-16 grid gap-12 sm:grid-cols-3">
            {howItWorks.map((item) => (
              <div
                key={item.step}
                className="flex flex-col items-center text-center"
              >
                <div className="bg-primary text-primary-foreground mb-4 flex size-12 items-center justify-center rounded-full text-xl font-bold">
                  {item.step}
                </div>
                <h3 className="text-xl font-semibold">{item.title}</h3>
                <p className="text-muted-foreground mt-2">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING TEASER ────────────────────────────────────────────────── */}
      <section className="px-4 py-24 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              {t("pricing_title")}
            </h2>
            <p className="text-muted-foreground mt-4 text-lg">
              {t("pricing_subtitle")}
            </p>
          </div>

          <div className="mt-16 grid gap-8 lg:grid-cols-4">
            {/* Free */}
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle>Free</CardTitle>
                <CardDescription>{t("pricing_free_tagline")}</CardDescription>
                <div className="mt-4 text-4xl font-bold">$0</div>
                <p className="text-muted-foreground text-sm">
                  {t("pricing_free_price")}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  60s of clips/month
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  15 subtitle styles
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  ClipsFlow watermark
                </div>
              </CardContent>
              <div className="p-6 pt-0">
                <Link
                  href={`/${locale}/login`}
                  className="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-8 w-full items-center justify-center rounded-md border text-sm font-medium transition-colors"
                >
                  {t("pricing_free_cta")}
                </Link>
              </div>
            </Card>

            {/* Solo */}
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle>Solo</CardTitle>
                <CardDescription>{t("pricing_solo_tagline")}</CardDescription>
                <div className="mt-4 text-4xl font-bold">$29</div>
                <p className="text-muted-foreground text-sm">
                  {t("pricing_solo_price")}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  480s of clips/month
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  15 subtitle styles
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  No watermark
                </div>
              </CardContent>
              <div className="p-6 pt-0">
                <Link
                  href={`/${locale}/login`}
                  className="bg-primary text-primary-foreground hover:bg-primary/80 inline-flex h-8 w-full items-center justify-center rounded-md text-sm font-medium transition-colors"
                >
                  {t("pricing_solo_cta")}
                </Link>
              </div>
            </Card>

            {/* Pro */}
            <Card className="border-primary relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <Badge className="bg-primary text-primary-foreground">
                  {t("pricing_popular")}
                </Badge>
              </div>
              <CardHeader>
                <CardTitle>Pro</CardTitle>
                <CardDescription>{t("pricing_pro_tagline")}</CardDescription>
                <div className="mt-4 text-4xl font-bold">$79</div>
                <p className="text-muted-foreground text-sm">
                  {t("pricing_pro_price")}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  1800s of clips/month
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  All styles + custom colors
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  No watermark
                </div>
              </CardContent>
              <div className="p-6 pt-0">
                <Link
                  href={`/${locale}/login`}
                  className="bg-primary text-primary-foreground hover:bg-primary/80 inline-flex h-8 w-full items-center justify-center rounded-md text-sm font-medium transition-colors"
                >
                  {t("pricing_pro_cta")}
                </Link>
              </div>
            </Card>

            {/* Studio */}
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle>Studio</CardTitle>
                <CardDescription>{t("pricing_studio_tagline")}</CardDescription>
                <div className="mt-4 text-4xl font-bold">$199</div>
                <p className="text-muted-foreground text-sm">
                  {t("pricing_studio_price")}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  3600s of clips/month
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  Everything unlocked
                </div>
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Check className="size-4 text-green-500" />
                  All positions + animations
                </div>
              </CardContent>
              <div className="p-6 pt-0">
                <Link
                  href={`/${locale}/login`}
                  className="bg-primary text-primary-foreground hover:bg-primary/80 inline-flex h-8 w-full items-center justify-center rounded-md text-sm font-medium transition-colors"
                >
                  {t("pricing_studio_cta")}
                </Link>
              </div>
            </Card>
          </div>

          <div className="mt-10 text-center">
            <Link
              href={`/${locale}/pricing`}
              className="text-primary inline-flex items-center gap-2 text-sm font-medium hover:underline"
            >
              {t("pricing_view_all")}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <section className="border-border/40 bg-muted/30 border-t px-4 py-24 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              {t("faq_title")}
            </h2>
          </div>

          <div className="mt-16 space-y-8">
            <div>
              <h3 className="text-lg font-semibold">{t("faq_q1_title")}</h3>
              <p className="text-muted-foreground mt-2">{t("faq_q1_answer")}</p>
            </div>
            <div>
              <h3 className="text-lg font-semibold">{t("faq_q2_title")}</h3>
              <p className="text-muted-foreground mt-2">{t("faq_q2_answer")}</p>
            </div>
            <div>
              <h3 className="text-lg font-semibold">{t("faq_q3_title")}</h3>
              <p className="text-muted-foreground mt-2">{t("faq_q3_answer")}</p>
            </div>
            <div>
              <h3 className="text-lg font-semibold">{t("faq_q4_title")}</h3>
              <p className="text-muted-foreground mt-2">{t("faq_q4_answer")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ─────────────────────────────────────────────────────── */}
      <section className="px-4 py-24 sm:px-6 sm:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-foreground text-4xl font-bold tracking-tight sm:text-5xl">
            {t("final_title")}
          </h2>
          <p className="text-muted-foreground mx-auto mt-6 max-w-xl text-lg leading-8">
            {t("final_subtitle")}
          </p>
          <div className="mt-10 flex items-center justify-center gap-x-6">
            <Link
              href={`/${locale}/login`}
              className="group bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center rounded-md px-8 text-sm font-medium shadow transition-colors focus-visible:outline-none"
            >
              {t("final_cta")}
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── FOOTER ────────────────────────────────────────────────────────── */}
      <footer className="border-border/40 border-t px-4 py-12 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 sm:flex-row">
          <Link href={`/${locale}`} className="text-lg font-bold">
            ClipsFlow
          </Link>
          <p className="text-muted-foreground text-sm">{t("footer_text")}</p>
        </div>
      </footer>
    </main>
  );
}
