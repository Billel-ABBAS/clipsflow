# Roadmap — PolyCast

> Source : MEGAPROMPT v2.0 (Phases 0 → 4). Une phase à la fois, gate ⏸️ entre chaque.

| Phase | Objectif                                | Durée | Livrable clé                                     | Statut                       |
| ----- | --------------------------------------- | ----- | ------------------------------------------------ | ---------------------------- |
| **0** | Audit VidiaFlow + scaffold              | 3h    | `CLIPFLOW_EXTRACTION_MAP.md` + repo buildable    | ✅ done (tag `phase-0-done`) |
| **1** | Port ClipFlow (secondaire)              | 1 sem | Module clips end-to-end + tests ≥50%             | 🚧 code livré — gate en attente : smoke test fondateur + report + tag `phase-1-done` |
| **2** | Hero dubbing + consentement AI Act      | 2 sem | Pipeline dub 5 langues GA + SRT/VTT + disclosure | —                            |
| **3** | Stripe + auth + onboarding + rate limit | 1 sem | Produit monétisable, déployé                     | —                            |
| **4** | Self-host VoxCPM2 (⚠️ conditionnel PMF) | 1 sem | −70%+ coût/job, fallback testé                   | —                            |

## Gates

- Chaque phase se termine par : `docs/reports/PHASE_N_REPORT.md` + tag git `phase-N-done` + **STOP**.
- Reprise de phase : préambule Annexe E du mégaprompt + bloc de phase.
- Rollback : `git reset --hard phase-N-done && git clean -fd` (⚠️ détruit le travail non commité).

## 🚫 Verrou Phase 4

Interdiction de démarrer sans **50+ payants OU $5k MRR** (preuve : screenshot dashboard Stripe collé dans le report). Sans ce signal → retour acquisition/marketing, pas d'optimisation.

## Definition of Done globale

- Prod Vercel + Supabase + Stripe live ; 3 tiers $29/$79/$199 ; trial watermarké
- Dubbing voice-cloné multilingue (GA benchmarkées MOS-lite ≥3.8 + beta), SRT/VTT, clips IA, thumbnails
- Consentement vocal bloquant + disclosure AI Act Art. 50 sur chaque output
- Coût/job optimisé (P4) avec fallback bridge permanent
- ggshield/RLS/rate-limits partout ; commits propres ; tags par phase
- **Acquire-ready** : git history clean, README investisseur, exports métriques (MRR Stripe, `cost_ledger`, `usage_meters`), 5 `PHASE_REPORT` = data room technique

## Pricing cible (P3)

| Plan   | $/mois | Quotas clés                                                                  |
| ------ | ------ | ---------------------------------------------------------------------------- |
| free   | 0      | trial unique : 1 dub 5 min watermarké, 1 langue, 3 clips total, 2 thumbnails |
| solo   | 29     | 240 min/mois, 1 langue, 10 clips/épisode, 50 thumbs/mois                     |
| pro    | 79     | 900 min/mois, 5 langues, 30 clips/épisode, 200 thumbs/mois                   |
| studio | 199    | 1800 min/mois, 30 langues, clips/thumbs illimités                            |
