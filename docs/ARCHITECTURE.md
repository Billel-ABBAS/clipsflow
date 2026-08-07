# Architecture — PolyCast

> Document vivant. Phase 0 : fondations seulement. Mis à jour à chaque phase.

## Vue d'ensemble

```
Next.js 16.2 App Router (Vercel)
├── src/proxy.ts                  # ⚠️ Next 16 : remplace middleware.ts (déprécié)
│     1. next-intl  → normalise /pricing → /en/pricing (localePrefix: always)
│     2. Supabase   → refresh session, cookies layered SUR la réponse intl
├── src/app/[locale]/             # 2 locales Phase 0 : en (défaut), fr
│   ├── layout.tsx                # <html lang> + NextIntlClientProvider
│   └── page.tsx                  # home placeholder (hero + 3 features)
├── src/app/layout.tsx            # pass-through (pattern VidiaFlow, prouvé sur 16.2)
├── src/i18n/                     # routing / navigation / request / messages
├── src/lib/supabase/             # client (browser) · server (RSC) · middleware (proxy)
└── supabase/migrations/          # 0001_init.sql = profiles + RLS + trigger
```

## Décisions structurantes

| #   | Décision                                                       | Pourquoi                                                                                      | Alternative écartée                                                 |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `src/proxy.ts` (convention Next 16)                            | `middleware.ts` est déprécié dans Next 16 (docs embarquées)                                   | Garder middleware.ts (legacy dès J1)                                |
| 2   | Cookies Supabase layerés SUR la réponse next-intl              | Écraser la réponse intl casse `useLocale()` (incident VidiaFlow PR #43)                       | 2 réponses fusionnées à la main                                     |
| 3   | Clients Supabase avec placeholders + proxy no-op sans env vars | Projet Supabase pas encore créé ; build/dev doivent rester verts                              | Crash au boot tant que les keys manquent                            |
| 4   | shadcn v4 primitives **base-ui**, thème neutre                 | Megaprompt : design neutre, pas de noir-studio ; base-ui = choix shadcn v4 actuel             | Radix (ancienne génération)                                         |
| 5   | 2 locales (en/fr) Phase 0, extension P3                        | Chaque locale déclarée sans bundle = erreur runtime                                           | Déclarer 6 locales avec bundles vides                               |
| 6   | pnpm + `pnpm-workspace.yaml > allowBuilds`                     | pnpm ≥10 bloque les postinstall par défaut (supply chain) ; allowlist explicite de 6 packages | `pnpm.onlyBuiltDependencies` dans package.json (ignoré par pnpm 11) |
| 7   | Vitest (environment node) + alias `@`                          | Megaprompt impose Vitest ; tests colocalisés `src/**/*.test.ts`                               | Jest (plus lourd, double config TS)                                 |
| 8   | Husky pre-commit : ggshield gate gracieux → durcissable        | ggshield pas encore authentifié (action founder) ; le hook devient hard gate dès l'auth       | Hook strict immédiat = tous les commits bloqués                     |

## Modèle de données (Phase 0)

`profiles` (id FK auth.users, email, full_name, locale, timestamps) — RLS own-row SELECT/UPDATE, INSERT via trigger `handle_new_user` (security definer, search_path pinné), `updated_at` via trigger.

Schéma cible Phase 1 (épisodes/clips/jobs) : voir `docs/CLIPFLOW_EXTRACTION_MAP.md` section 4.

## Pipeline cible (rappel produit)

- **P1 — Clips** : upload/URL → Whisper (Groq) → ASS/libass burn ffmpeg → storage → galerie realtime
- **P2 — Dubbing** : ASR → segmentation → traduction length-controlled (Claude) → voice clone (consent gate) → synthèse → alignement `atempo` 0.92–1.08 → loudnorm −16 LUFS → SRT/VTT → disclosure Art. 50
- **P3 — Monétisation** : Stripe 3 tiers + trial unique watermarké + Upstash rate limit
- **P4 — VoxCPM2 self-host** : verrou PMF (50+ payants OU $5k MRR), rollout par flag, fallback bridge permanent

## Interface voice provider (P2, pour mémoire)

```typescript
export interface VoiceProvider {
  cloneVoice(
    refAudio: Buffer,
    refTranscript: string,
    lang: string,
  ): Promise<VoiceCloneResult>;
  synthesize(
    text: string,
    voiceId: string,
    lang: string,
    opts?: { speed?: number },
  ): Promise<SynthesisResult>;
  estimateCost(textLength: number, lang: string): number;
}
// impls : fal-voxcpm.ts | elevenlabs.ts | index.ts (factory par env VOICE_PROVIDER)
```

## Sécurité

- ggshield sur chaque commit (hook husky) ; scan path complet à chaque gate
- RLS sur toute table user ; `SUPABASE_SERVICE_ROLE_KEY` server-only
- VidiaFlow en deny mécanique (`.claude/settings.json`)
- Reviewer `securite` (sub-agent) obligatoire avant chaque merge → verdict PASS requis
