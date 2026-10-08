import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en.json";
import frMessages from "@/i18n/messages/fr.json";
import { PricingCards } from "@/components/pricing/PricingCards";

const translationState = vi.hoisted(() => ({
  messages: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    key.split(".").reduce<unknown>((value, part) => {
      if (!value || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[part];
    }, translationState.messages) as string,
}));

describe("PricingCards source-analysis quotas", () => {
  it.each([
    {
      locale: "fr",
      messages: frMessages.pricing,
      quotas: [
        "1 h de sources analysées/mois",
        "10 h de sources analysées/mois",
        "40 h de sources analysées/mois",
        "120 h de sources analysées/mois",
      ],
    },
    {
      locale: "en",
      messages: enMessages.pricing,
      quotas: [
        "1 hour of source analysis/month",
        "10 hours of source analysis/month",
        "40 hours of source analysis/month",
        "120 hours of source analysis/month",
      ],
    },
  ])(
    "shows source and rendered-clip limits for $locale",
    ({ locale, messages, quotas }) => {
      translationState.messages = messages;
      const markup = renderToStaticMarkup(
        <PricingCards locale={locale} isLoggedIn={false} />,
      );

      for (const quota of quotas) expect(markup).toContain(quota);
      expect(markup).toContain("pricing-source-quota-free");
      expect(markup).toMatch(/clips rendus|rendered clips/u);
    },
  );
});
