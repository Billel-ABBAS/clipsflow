# ClipsFlow

> SaaS B2C de création de Shorts à partir de vidéos et podcasts de 20 minutes à 2 heures : analyse audio ou audio + vidéo, propositions des meilleurs extraits, puis génération avec sous-titres synchronisés, musique et motion design.

## Stack

Next.js 16 App Router · TS strict · Tailwind v4 · shadcn/base-ui · Supabase · Railway workers · Vercel/Sentry · next-intl (en/fr) · FFmpeg · Whisper/Groq ou OpenAI · analyse vidéo configurable · ElevenLabs (musique/SFX, serveur uniquement) · Claude Opus 5.5 (`claude-opus-5-5`, appels protégés par budget/flag) · Jev TypeSafe (classement shadow opt-in)

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
9. Les appels IA payants restent bloqués sans autorisation explicite du budget et clés serveur ; aucune clé dans le client.
10. Une publication YouTube exige OAuth utilisateur, récapitulatif de destination/visibilité et confirmation explicite juste avant l'envoi.
11. Jev ne change pas l'ordre servi en mode shadow ; préserver le classement déterministe jusqu'à une évaluation contrôlée.

## Périmètre

**Parcours Shorts long format** : import vidéo/podcast de 20 min à 2 h → transcription complète et analyse audio ou audio + vidéo, guidées par les consignes utilisateur → sélection manuelle ou automatique des extraits → génération FFmpeg avec sous-titres synchronisés, musique/SFX autorisés et motion design → téléchargement MP4/VTT individuel ou ZIP → connexion YouTube et publication après confirmation.

Le flux Clips existant reste disponible séparément : épisode → segment court → style et personnalisation → rendu FFmpeg → galerie privée. Les workers d'analyse Shorts, de rendu et de publication sont des services asynchrones distincts ; leur présence dans le code ne prouve pas leur provisionnement en staging ou production.

**Garde-fous fournisseurs** : Anthropic confirme l'identifiant Opus 5.5 `claude-opus-5-5`; ne pas le remplacer par Opus 5 (`claude-opus-5`). Tout appel reste interdit sans budget explicitement autorisé, flag serveur et clé privée. ElevenLabs est limité à la musique instrumentale/SFX avec consentement, licence et budget validés. Jev est optionnel, avec consentement du créateur et résultats shadow uniquement.

Quotas par plan (free/solo/pro/studio) via RPC atomiques `clips_consume_quota` / `clips_refund_quota`.

Détails : @docs/ARCHITECTURE.md · @docs/ROADMAP.md · @docs/reports/

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
