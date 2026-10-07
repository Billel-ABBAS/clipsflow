import Image from "next/image";
import { ArrowRight, Film, Scissors, Subtitles, Zap } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ClipsFlowBrand } from "@/components/ClipsFlowBrand";
import { MarketingHeader } from "@/components/MarketingHeader";
import { PricingCards } from "@/components/pricing/PricingCards";
import {
  Card,
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
  const shortsLoginHref = `/${locale}/login?next=%2Fshorts`;

  const features = [
    {
      icon: Film,
      title: t("feature_shorts_title"),
      description: t("feature_shorts_desc"),
      color: "text-[#a995ff]",
    },
    {
      icon: Scissors,
      title: t("feature_clips_title"),
      description: t("feature_clips_desc"),
      color: "text-[#22d3ee]",
    },
    {
      icon: Subtitles,
      title: t("feature_dub_title"),
      description: t("feature_dub_desc"),
      color: "text-[#36f0cf]",
    },
    {
      icon: Zap,
      title: t("feature_consent_title"),
      description: t("feature_consent_desc"),
      color: "text-[#fb604b]",
    },
  ];

  const howItWorks = [
    { step: "1", title: t("step1_title"), desc: t("step1_desc") },
    { step: "2", title: t("step2_title"), desc: t("step2_desc") },
    { step: "3", title: t("step3_title"), desc: t("step3_desc") },
  ];

  return (
    <main className="bg-background text-foreground min-h-screen">
      <MarketingHeader locale={locale} primaryLabel={t("cta_primary")} />

      {/* ── HERO ──────────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden px-4 py-12 sm:px-6 sm:py-14 lg:py-16">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute top-0 left-[12%] size-[28rem] rounded-full bg-[#6844ff]/15 blur-3xl" />
          <div className="absolute top-1/4 right-[8%] size-[24rem] rounded-full bg-[#22d3ee]/10 blur-3xl" />
        </div>

        <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] xl:gap-14">
          <div className="mx-auto w-full max-w-xl text-center lg:mx-0 lg:text-left">
            <Badge variant="secondary" className="mb-5 gap-1.5">
              <span className="size-1.5 rounded-full bg-[#36f0cf]" />
              {t("badge")}
            </Badge>

            <h1 className="text-foreground text-4xl leading-[1.08] font-bold tracking-tight sm:text-5xl lg:text-4xl xl:text-5xl">
              {t("hero_part1")}{" "}
              <span className="bg-gradient-to-r from-[#a995ff] to-[#36f0cf] bg-clip-text text-transparent">
                {t("hero_highlight")}
              </span>{" "}
              {t("hero_part2")}
            </h1>

            <p className="text-muted-foreground mx-auto mt-5 max-w-xl text-base leading-7 sm:text-lg sm:leading-8 lg:mx-0">
              {t("subtitle")}
            </p>

            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <Link
                href={shortsLoginHref}
                className="group bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 items-center justify-center rounded-md px-7 text-sm font-semibold shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                {t("cta_primary")}
                <ArrowRight className="ml-2 size-4 transition-transform group-hover:translate-x-1" />
              </Link>
              <a
                href="#how-it-works"
                className="border-input bg-background hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 items-center justify-center rounded-md border px-6 text-sm font-medium shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                {t("cta_secondary")}
              </a>
            </div>

            <p className="text-muted-foreground mx-auto mt-6 max-w-xl text-xs leading-5 sm:text-sm lg:mx-0">
              {t("social_proof")}
            </p>
          </div>

          <div className="relative mx-auto w-full max-w-[760px] lg:justify-self-end">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -inset-5 rounded-[2rem] bg-gradient-to-br from-[#6844ff]/20 via-transparent to-[#22d3ee]/10 blur-2xl"
            />
            <figure className="border-border/80 bg-card/85 relative overflow-hidden rounded-xl border p-2.5 shadow-[0_24px_80px_rgba(0,0,0,0.44)] backdrop-blur-xl sm:rounded-2xl sm:p-3">
              <figcaption className="mb-2.5 flex items-center justify-between gap-3 px-1.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="size-2 shrink-0 rounded-full bg-[#36f0cf] shadow-[0_0_12px_rgba(54,240,207,0.55)]" />
                  <span className="text-foreground truncate text-sm font-semibold">
                    {t("preview_label")}
                  </span>
                </div>
                <Badge variant="secondary" className="shrink-0 text-xs">
                  {t("preview_status")}
                </Badge>
              </figcaption>
              <div className="border-border/70 bg-background overflow-hidden rounded-lg border">
                <Image
                  src="/images/shorts-reference/canva-studio-selection.png"
                  alt={t("preview_alt")}
                  width={1487}
                  height={1058}
                  sizes="(min-width: 1280px) 720px, (min-width: 1024px) 58vw, 100vw"
                  priority
                  className="block h-auto w-full"
                />
              </div>
            </figure>
          </div>
        </div>
      </section>

      {/* ── FEATURES ──────────────────────────────────────────────────────── */}
      <section id="features" className="px-4 py-24 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="text-center">
            <h2 className="text-foreground text-3xl font-bold tracking-tight sm:text-4xl">
              {t("features_title")}
            </h2>
            <p className="text-muted-foreground mt-4 text-lg">
              {t("features_subtitle")}
            </p>
          </div>

          <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
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
          <div className="mt-10 flex justify-center">
            <Link
              href={shortsLoginHref}
              className="text-primary inline-flex items-center gap-2 text-sm font-medium hover:underline"
            >
              {t("feature_shorts_cta")}
              <ArrowRight className="h-4 w-4" />
            </Link>
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

          <div className="mt-16">
            <PricingCards locale={locale} isLoggedIn={false} />
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
              href={shortsLoginHref}
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
          <ClipsFlowBrand />
          <p className="text-muted-foreground text-sm">{t("footer_text")}</p>
        </div>
      </footer>
    </main>
  );
}
