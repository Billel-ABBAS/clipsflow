# Clipsflow — hébergement applicatif intégral sur Railway

## Cible et état au 9 novembre 2026

Projet Railway existant : `clipsflow` (production). Le SaaS conserve Supabase
comme base externe (Auth, PostgreSQL et Storage) et Stripe comme prestataire
de paiement. **Le frontend Next.js, les routes API et les workers de traitement
tournent sur Railway**, sans recours aux fonctions Vercel.

| Service | Rôle | Commande |
|---|---|---|
| clipsflow-web | site Next.js + routes API, public | `pnpm start`, port `8080`, `/api/health` |
| clips-worker-production | rendu vidéo FFmpeg | `node_modules/.bin/tsx scripts/clips-worker.ts`, Cron `*/5 * * * *` |
| shorts-analysis-worker-production | analyse Shorts | `node_modules/.bin/tsx scripts/shorts-analysis-worker.ts`, Cron `*/5 * * * *` |
| youtube-publish-worker | publication YouTube après OAuth et confirmation | `node_modules/.bin/tsx scripts/youtube-publish-worker.ts`, Cron `*/5 * * * *` |

Les trois workers sont isolés. Une seule instance active de chaque travailleur
doit consommer la file en production ; les variantes *canary* restent désactivées
et ne doivent pas acquérir de jobs.

### Services de validation créés

- `clipsflow-web-railway-canary` → `clipsflow-web-railway-canary-production.up.railway.app`
- `clipsflow-render-canary`
- `clipsflow-shorts-analysis-canary`
- `clipsflow-youtube-canary`

Tous pointent vers `feat/voicestudio-shorts-ui-20261109`. Le web canary passe
`next build` et le healthcheck Railway. Les workers canary ont leurs flags
de traitement sur `false` ; la compilation, les tests unitaires et leur
fonctionnement sur données fictives doivent être revérifiés avant fusion.

### Audio libre

- `VoiceStudio` est le moteur vocal via `/v1/audio/speech`.
- `Soundbox` fournit la musique ACE-Step 1.5 Turbo et les SFX
  MiDashengLM-Gen, via des jobs asynchrones.
- Aucune activation en production sans vérifier les licences précises des
  checkpoints, tester l'inférence, limiter les ressources et configurer les
  secrets. Les modèles ne sont **pas déployés** sur le web canary.
- Railway n'offre pas de GPU dans cette infrastructure : l'inférence sur CPU
  peut être très lente. Le choix d'un GPU externe ne doit pas être camouflé
  comme un service Railway. Pour un déploiement réellement 100 % Railway,
  accepter et mesurer le rendu CPU avec un budget adapté, ou choisir des
  moteurs CPU plus légers en remplacement.

### Configuration et sécurité

Conserver les variables sensibles dans Railway uniquement, via
références interservices au lieu de dupliquer les valeurs. Ne pas copier
les secrets dans ce dépôt ni les afficher dans les logs. Mettre
`NEXT_PUBLIC_APP_URL` sur l'adresse Railway réelle du service web.
Actualiser les origines/callbacks autorisées dans Supabase, Stripe, Google
OAuth/YouTube après le changement de domaine ; vérifier séparément chacun.

Les flags `CLIPS_SOUNDBOX_ENABLED`, `CLIPS_VOICESTUDIO_ENABLED`,
`CLIPS_WORKER_ENABLED`, `SHORTS_ANALYSIS_WORKER_ENABLED` et
`YOUTUBE_PUBLISH_WORKER_ENABLED` restent fermés tant que chaque service
n'a pas prouvé son état de santé et sa conformité. Pas de bascule de production
ou de suppression de Vercel tant que les parcours auth, paiement, import,
analyse, FFmpeg, stockage, téléchargement et publication ne sont pas validés.

### Ordre du cutover

1. Valider les PR empilées #53 à #57 et leurs tests sur la branche complète.
2. Valider la migration SQL `20261109130000_allow_soundbox_shorts_audio.sql`
   dans Supabase staging, puis appliquer en production après revue.
3. Construire et vérifier les workers canary sur Railway ; tester les flux avec
   des fixtures synthétiques sans appel IA payant.
4. Déployer VoiceStudio/Soundbox sur capacité CPU suffisante, modèles installés
   et licences contrôlées. Valider les formats audio et les temps d'inférence.
5. Raccorder le service web Railway aux workers, en conservant une seule file
   de consommateurs active. Vérifier tous les callbacks sur le domaine retenu.
6. Basculer le DNS et les webhooks vers Railway ; surveiller et garder une
   procédure de retour arrière. Ne désactiver l'ancien service que lorsque
   tous les tests E2E réussissent.

## Dépendances externes qui restent

Supabase, Stripe, Google/YouTube et les fournisseurs d'IA d'analyse configurés
ne sont pas des hébergements de l'application chez Vercel. Ils peuvent rester
externes. Cette migration n'implique pas une migration de base PostgreSQL
Supabase vers Railway.
