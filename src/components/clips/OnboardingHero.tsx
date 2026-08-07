"use client";

// ============================================================================
// OnboardingHero — first-run tutorial overlay (dismissible).
// Ported from VidiaFlow src/components/clipflow/OnboardingHero.tsx.
// Adaptations : storage helpers → @/lib/clips/onboarding-storage (key prefix
// "ClipsFlow-") ; i18n namespace → clips.onboarding ; the "demo mode" CTA
// (`/clips/new?demo=1`) is dropped — ClipsFlow P1 has no demo seed.
//
// Detection rule : localStorage `ClipsFlow-onboarding-clips` !== 'dismissed'.
// SSR-safe — mount-only check + initial null render prevents hydration
// mismatch.
// ============================================================================

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button, buttonVariants } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import {
  dismissClipsOnboarding,
  shouldShowClipsOnboarding,
} from "@/lib/clips/onboarding-storage";
import { cn } from "@/lib/utils";

export function OnboardingHero() {
  const t = useTranslations("clips.onboarding");
  // SSR-safe mount gate. The initial render returns null so server +
  // client markup match ; the effect decides post-hydration whether to
  // actually render the card.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Intentional : SSR-safe localStorage read happens AFTER hydration to
    // avoid a server/client markup mismatch. Mount-only setState.
    if (typeof window === "undefined") return;
    if (shouldShowClipsOnboarding(window.localStorage)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const handleDismiss = () => {
    if (typeof window !== "undefined") {
      dismissClipsOnboarding(window.localStorage);
    }
    setVisible(false);
  };

  return (
    <section
      data-testid="clips-onboarding-hero"
      aria-labelledby="clips-onboarding-heading"
      className="border-border from-muted/60 via-card to-card relative overflow-hidden rounded-xl border bg-gradient-to-br p-6"
    >
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t("dismiss_aria")}
        data-testid="clips-onboarding-dismiss"
        className="text-muted-foreground hover:bg-muted hover:text-foreground absolute top-3 right-3 rounded-md p-1.5 transition-colors"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="mb-4 flex items-center gap-2">
        <span className="bg-primary/10 text-primary flex h-8 w-8 items-center justify-center rounded-md">
          <Sparkles className="h-4 w-4" />
        </span>
        <div>
          <h2
            id="clips-onboarding-heading"
            className="text-foreground text-lg font-semibold tracking-tight"
          >
            {t("title")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        </div>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Step title={t("step1_title")} body={t("step1_body")} />
        <Step title={t("step2_title")} body={t("step2_body")} />
        <Step title={t("step3_title")} body={t("step3_body")} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/clips/new"
          className={cn(buttonVariants({ size: "sm" }))}
          data-testid="clips-onboarding-cta-start"
        >
          {t("cta_start")}
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          className="text-muted-foreground ml-auto text-xs"
        >
          {t("dismiss")}
        </Button>
      </div>
    </section>
  );
}

function Step({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-border bg-background/60 rounded-lg border p-3">
      <p className="text-foreground text-sm font-semibold">{title}</p>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
        {body}
      </p>
    </div>
  );
}
