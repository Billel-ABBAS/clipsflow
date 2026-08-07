import { defineRouting } from "next-intl/routing";

// Phase 0 : en + fr seulement (messages existants).
// Extension prévue Phase 3 (auth UI) : es, de, ja, ar — ajouter le bundle
// dans src/i18n/messages/ AVANT d'ajouter la locale ici.
export const locales = ["en", "fr"] as const;
export type Locale = (typeof locales)[number];

export const routing = defineRouting({
  locales,
  defaultLocale: "en",
  localePrefix: "always",
});
