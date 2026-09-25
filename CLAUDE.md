# ClipsFlow

> SaaS B2C : transformation de vidéos/épisodes longs en clips courts sous-titrés prêts à poster (TikTok, Reels, Shorts). Produit clips-only — PAS de doublage, PAS de thumbnails IA, PAS d'analyse vidéo, PAS de SEO-tool.

## Stack

Next.js 16.2 App Router · TS strict · Tailwind v4 · shadcn v4 base-ui (design **neutre**, PAS de noir-studio) · Supabase eu-west · Vercel/Sentry · next-intl (en/fr) · ffmpeg · Whisper · OpenAI (traduction cues) · pnpm ≥9

⚠️ **Next 16 : `src/proxy.ts`, PAS `middleware.ts`** (convention renommée — voir docs embarquées `node_modules/next/dist/docs`). Lire ces docs avant tout code Next non trivial.

## Hard rules

1. ggshield gate sur tout commit (hook husky — durcir en gate strict après `ggshield auth login`)
2. API keys uniquement `.env.local` — jamais chat, jamais commit
3. Supabase MCP read_only ; migrations testées en read_only avant exécution
4. Stripe : test keys jusqu'à validation manuelle ; live swap = action utilisateur
5. Commits FR conventional ; PR < 400 lignes hors lockfile
6. Imports alias `@/*` ; aucune feature sans test
7. Tout endpoint job IA passe par contrôle quota + rate limit
8. Watermark Free obligatoire — jamais de bypass côté client

## Périmètre

**Recette d'un clip** : source (upload ≤500 MB / URL HTTPS / épisode existant) → segment (≤3 min) → style sous-titres (15) → personnalisation (couleurs/police/position/emphasis) → overlays (title card, bandeau intervenant, compteur, CTA) → render ffmpeg → galerie realtime (MP4 + VTT).

Quotas par plan (free/solo/pro/studio) via RPC atomiques `clips_consume_quota` / `clips_refund_quota`.

Détails : @docs/ARCHITECTURE.md · @docs/ROADMAP.md · @docs/reports/
