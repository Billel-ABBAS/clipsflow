# Roadmap — ClipsFlow

> Produit : transformation de vidéos/épisodes longs en clips courts sous-titrés prêts à poster (TikTok, Reels, Shorts). Pas de doublage, pas de thumbnails IA.

## Phases livrées

| Phase  | Objectif                                                         | Statut      |
| ------ | ---------------------------------------------------------------- | ----------- |
| **P0** | Scaffold + audit ClipFlow                                        | ✅ done     |
| **P1** | Port clips end-to-end (upload → Whisper → burn ffmpeg → galerie) | ✅ done     |
| **P2** | Billing Stripe (3 tiers live) + migrations DB + webhook          | ✅ done     |
| **P3** | Hardening prod : rate limits, Sentry, RGPD, tests                | 🚧 en cours |

## Ce qui est en place

### Core produit

- **Studio 4 étapes** : source (upload ≤500 MB / URL / épisode) → segment (≤3 min) → style (15 prédéfinis) → personnalisation
- **12 presets** platform-specific (TikTok, Hormozi, LinkedIn, etc.)
- **Pipeline** : Whisper transcription → OpenAI traduction cues → ffmpeg burn (sous-titres animés) → smart crop → galerie realtime
- **Overlays** : title card, bandeau intervenant, stat callout, CTA outro
- **Webhook Stripe** : mise à jour automatique du plan

### Infra

- **DB** : Supabase (auth, 3 + 1 tables, RPC quotas, storage privé 2 buckets)
- **Paiement** : Stripe (3 produits live, webhook checkout.session.completed + subscription.updated/deleted)
- **Deploy** : Vercel prod auto depuis `main`
- **Monitoring** : Sentry branché (erreurs + breadcrumbs serveur)
- **Sécurité** : RLS sur toutes les tables, rate limit 30 req/min sur transcribe, SSRF guard, PII scrubber Sentry, policies storage

### Plans (quotas seconds de clip rendu / mois)

| Plan   | $/mois | Quota | Features                                        |
| ------ | ------ | ----- | ----------------------------------------------- |
| free   | 0      | 60s   | 15 styles prédéfinis, watermark ClipsFlow       |
| solo   | 29     | 480s  | 15 styles prédéfinis, pas de watermark          |
| pro    | 79     | 1800s | + custom colors (palette pro), pas de watermark |
| studio | 199    | 3600s | + custom hex, fonts, positions, animations      |

## Ce qui reste à faire

### Critique (post-lancement)

- [ ] Tester le flow complet signup → upload → render → download
- [ ] Vérifier que le webhook Stripe met à jour `profiles.plan` après paiement réel
- [ ] Sentry : vérifier que les erreurs arrivent dans le dashboard Sentry (https://sentry.io)

### Recommandé

- [ ] Onboarding : page "premier clip" guidée
- [ ] Settings : page compte (suppression RGPD, langue, notifications)
- [ ] Landing : A/B test copy (titre, sous-titre)
- [ ] Clip edit : régénérer un clip dans un autre style sans re-upload

### Optionnel

- [ ] Analytics : PostHog funnel activation (signup → first clip → upgrade)
- [ ] Email : Resend notification "clip prêt"
- [ ] API publique (pour intégrateurs)

## Standards qualité

- Typecheck : 0 erreur (`pnpm typecheck`)
- Tests : 272/272 verts (`pnpm test`)
- Lint : 0 erreur (`pnpm lint`)
- Build : vert (`pnpm build`)
- Secrets : jamais dans le repo, `.env.local` gitignored, `env.example` à jour
