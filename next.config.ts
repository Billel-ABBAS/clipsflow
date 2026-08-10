import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // ffmpeg : le binaire @ffmpeg-installer résout son chemin plateforme via
  // un require() dynamique que le bundler ne peut pas analyser — sans
  // serverExternalPackages, le tracer droppe le binaire et le burn meurt
  // au runtime. fluent-ffmpeg (dep Lot 1) suit le même régime CJS.
  serverExternalPackages: ["@ffmpeg-installer/ffmpeg", "fluent-ffmpeg"],
  // Le runtime Lambda Linux n'a AUCUNE police installée — libass skippe
  // silencieusement le rendu des sous-titres sans fontsdir peuplé. On
  // embarque fonts/ (Inter.ttf) dans le bundle de la route cron qui
  // exécute le burn (clé = route path, valeur = glob depuis la racine —
  // cf. node_modules/next/dist/docs/.../01-next-config-js/output.md).
  outputFileTracingIncludes: {
    "/api/cron/process-clips": ["./fonts/**/*"],
  },
};

export default withSentryConfig(withNextIntl(nextConfig), {
  // Ne pas uploader de sourcemaps en dev (économise le quota Sentry)
  silent: !process.env.CI,
});
