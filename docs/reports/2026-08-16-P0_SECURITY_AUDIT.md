# Audit profond sécurité, stabilité et production — ClipsFlow

Date : 16 août 2026  
Branche auditée : `fix/p0-security-hardening`  
Base de comparaison : `398caaa`  
Portée : dépendances, frontières navigateur/serveur/Postgres, authentification, facturation Stripe, traitement média, sorties réseau, observabilité, scripts d'exploitation et documentation.

## Résumé exécutif

L'audit initial a trouvé plusieurs chemins incompatibles avec une mise en production sûre : mutations métier accessibles au rôle navigateur, soumission non atomique, rate limit en mémoire, webhook Stripe non suffisamment robuste aux doublons/échecs/événements désordonnés, origine de redirection dérivée de la requête, sorties réseau exposées aux SSRF, fuite potentielle de données dans l'observabilité, watermark gratuit en fail-open, scripts Stripe dangereux et dépendances vulnérables.

Les chemins P0 ont été corrigés dans une branche et un worktree isolés. Aucun changement n'a été envoyé vers Supabase, Stripe ou la production. La connexion Supabase disponible ne correspondait pas au nom d'hôte configuré pour ce dépôt ; l'arrêt de la mutation distante est donc un contrôle réussi, pas un travail manquant exécuté silencieusement.

## Méthode

- cartographie des routes, tables, RPC, clients Supabase et appels réseau ;
- recherche des frontières d'autorisation, redirections, journaux, secrets et scripts destructifs ;
- reproduction par tests ciblés avant correction ;
- migrations créées avec Supabase CLI et validées contre Supabase local ;
- tests unitaires et tests SQL de sécurité ;
- audits de dépendances runtime et développement ;
- compilation Next.js de production et contrôles TypeScript/ESLint ;
- revue React ciblée des fichiers TSX modifiés ;
- vérification que les opérations externes non autorisées n'ont pas été exécutées.

## Constatations et remédiations

| ID    | Gravité initiale | Constat                                                                                                                                                           | Remédiation                                                                                                                                                                                                 | État                                              |
| ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| P0-01 | Critique         | Les rôles navigateur pouvaient participer directement au cycle de vie des épisodes, clips et jobs, et la protection des champs de facturation était insuffisante. | RLS forcée, privilèges de mutation révoqués, mise à jour du profil limitée à trois colonnes, trigger de défense en profondeur, mutations serveur.                                                           | Corrigé localement                                |
| P0-02 | Haute            | Réservation de quota, création du clip et création du job pouvaient diverger en cas d'échec partiel ou de concurrence.                                            | RPC `clips_submit_job` transactionnelle avec verrou du profil, contrôle de propriété et résultat typé.                                                                                                      | Corrigé localement                                |
| P0-03 | Haute            | Le rate limit en mémoire était contournable entre instances serverless et disparaissait au redémarrage.                                                           | Compteur Postgres atomique `consume_api_rate_limit`, limites par utilisateur et par action, échec fermé `503`, refus `429` avec `Retry-After`.                                                              | Corrigé localement                                |
| P0-04 | Critique         | Le webhook Stripe pouvait perdre un événement après échec, appliquer un doublon ou faire régresser un abonnement avec un événement ancien.                        | Journal d'événements avec claim/complete/fail, reprise des échecs ou claims périmés, écriture monotone sur `event.created`, prise en charge de tous les statuts Stripe attendus.                            | Corrigé localement                                |
| P0-05 | Haute            | Le plan pouvait dépendre de métadonnées non canoniques et les créations Stripe n'étaient pas entièrement idempotentes.                                            | Plan dérivé du prix réel de l'abonnement, récupération de la subscription Checkout, clés d'idempotence client/serveur stables, contrôle d'abonnement existant et persistance vérifiée du customer.          | Corrigé localement                                |
| P0-06 | Haute            | Les redirections OAuth/Checkout/Portal pouvaient dépendre d'une origine influencée par la requête ou d'un chemin de retour dangereux.                             | Origine unique via `NEXT_PUBLIC_APP_URL`, HTTPS obligatoire en production, validation stricte des chemins relatifs, aucun fallback vers le header Host.                                                     | Corrigé localement                                |
| P0-07 | Critique         | Plusieurs téléchargements média/logo pouvaient suivre des URLs ou redirections vers des destinations privées/réservées.                                           | `safeFetch` centralisé : HTTPS/443, pas d'identifiants URL, IP réservées bloquées, résolution A/AAAA publique, allowlist quand applicable, redirections revalidées, timeout et méthodes GET/HEAD seulement. | Corrigé localement avec risque résiduel documenté |
| P0-08 | Haute            | Messages, breadcrumbs ou URLs pouvaient exposer e-mails, jetons, clés et paramètres sensibles à l'observabilité.                                                  | Nettoyage récursif Sentry des chaînes, champs sensibles, tableaux, erreurs, breadcrumbs, URLs et formats de clés courants.                                                                                  | Corrigé localement                                |
| P0-09 | Critique revenus | Le watermark d'un plan gratuit pouvait échouer silencieusement et livrer le média sans marque.                                                                    | Politique fail-closed pour `free` et plans inconnus ; l'échec `watermark_failed` fait échouer le job et déclenche le remboursement normal du quota.                                                         | Corrigé localement                                |
| P0-10 | Haute            | Scripts Stripe historiques susceptibles de créer des objets ou d'ouvrir des consoles sans garde-fous ; procédures avec cibles obsolètes et confusion local/live.  | Scripts Python supprimés, setup Stripe test idempotent et dry-run, refus des clés live, smoke webhook local avec double consentement et nettoyage, runbooks réécrits.                                       | Corrigé localement                                |
| P0-11 | Haute            | Le graphe de dépendances contenait des avis connus, y compris dans Next/Sharp et l'outillage.                                                                     | Mise à jour des versions directes et overrides transitifs ciblés ; audit complet et production ramenés à zéro avis connu.                                                                                   | Corrigé localement                                |

## Garanties ajoutées par les tests

Les tests TypeScript couvrent notamment :

- validation des migrations et présence des privilèges/RPC attendus ;
- soumission atomique et traduction des erreurs de quota/propriété ;
- rate limit distribué, réponses invalides et fail-closed ;
- URL publique, IPv4/IPv6, DNS, allowlists, redirections et timeouts ;
- origine applicative et chemins OAuth ;
- état Stripe claim/échec/reprise/ordre ;
- scrubber Sentry récursif ;
- politique de watermark gratuite et plans inconnus ;
- garde-fous du script Stripe test.

Le test SQL `supabase/tests/p0_security.sql` exerce la migration réelle sur Postgres local : RLS forcée, ACL, rollback transactionnel, compteur distribué et machine d'état Stripe.

## Résultats de vérification finaux

| Contrôle                                   | Résultat frais du 16 août 2026                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                | 22 fichiers, 349 tests réussis                                                                                   |
| `pnpm typecheck`                           | Réussi, aucune erreur TypeScript                                                                                 |
| `pnpm lint`                                | Réussi, aucune erreur ESLint                                                                                     |
| `pnpm build`                               | Réussi avec Next.js 16.2.11 ; seul avertissement : détection de deux racines workspace liée au worktree imbriqué |
| `pnpm audit --audit-level moderate`        | Aucune vulnérabilité connue                                                                                      |
| `pnpm audit --prod --audit-level moderate` | Aucune vulnérabilité connue                                                                                      |
| `git diff --check`                         | Réussi                                                                                                           |
| Reset Supabase local                       | Migrations `0001`, `0002`, `0003` et P0 appliquées sur une base neuve                                            |
| Supabase DB lint                           | Aucune erreur de schéma                                                                                          |
| `supabase/tests/p0_security.sql`           | Réussi avec rollback final                                                                                       |
| Script Stripe test                         | Dry-run réussi sans clé ni appel Stripe                                                                          |
| Script webhook local                       | Refus attendu sans l'unique argument `--apply`                                                                   |
| Recherche de secrets par signatures fortes | Une seule fixture factice dans le test du scrubber Sentry ; aucun autre chemin courant ou historique détecté     |

Le hook Git signale que ggshield est installé mais non authentifié. La ligne correspondante reste donc une limite ouverte malgré la recherche locale réussie.

## Risques résiduels et améliorations après P0

### R1 — DNS rebinding entre contrôle et connexion

`safeFetch` vérifie toutes les réponses DNS juste avant l'appel, puis le client HTTP effectue sa propre résolution. La fenêtre est courte et les IP non publiques/redirections sont filtrées, mais la connexion n'est pas cryptographiquement liée à l'adresse contrôlée. Pour une assurance SSRF maximale, ajouter en P1 un proxy d'egress avec politique réseau ou un connecteur HTTP qui épingle l'IP validée tout en conservant le SNI/Host TLS. Priorité : haute avant l'ouverture large des imports URL arbitraires.

### R2 — Croissance des tables opérationnelles

`api_rate_limits` et `stripe_webhook_events` n'ont pas encore de politique de rétention automatisée. Ajouter une tâche de purge bornée, des métriques de volume et une alerte avant croissance significative. Priorité : moyenne.

### R3 — Artefacts orphelins

Un upload initialisé mais abandonné, ou un épisode URL créé avant une soumission refusée, peut laisser un objet/épisode orphelin. Ajouter une réconciliation périodique avec délai de grâce et suppression ciblée récupérable. Priorité : moyenne.

### R4 — Couverture navigateur réelle

La compilation et les tests de logique ne remplacent pas un parcours Chrome complet sur une preview avec OAuth, upload réel, rendu FFmpeg, Checkout test et retour webhook. Exécuter ce parcours après configuration d'un environnement correspondant. Priorité : haute avant production.

### R5 — Scanner de secrets institutionnel

Le hook indique que ggshield n'est pas authentifié ; sa gate est donc inactive. La recherche locale ne trouve qu'une fixture de test factice, mais l'organisation doit authentifier son scanner et activer une gate CI bloquante. Priorité : haute avant merge.

### R6 — Observabilité et reprise

Ajouter tableaux de bord et alertes pour : jobs bloqués, taux de `503` du limiteur, remboursements, événements Stripe `failed/processing` anciens, échecs watermark et refus SSRF. Priorité : moyenne.

### R7 — UX, accessibilité et performance

Les refactors UX n'ont volontairement pas précédé P0. Après stabilisation : tests clavier/lecteur d'écran, états de chargement et erreurs localisés, reprise d'upload, polling plus explicite, mesures Web Vitals et réduction des composants lourds si les mesures le justifient.

## Limites d'exécution

- aucune migration distante appliquée ;
- aucune valeur de secret d'un projet distant ou fournie par l'utilisateur n'a été lue en clair, affichée, créée ou tournée ;
- aucun produit/prix/webhook Stripe live créé ou modifié ;
- aucun déploiement Vercel ou promotion production ;
- aucun smoke test Chrome sur un environnement distant ;
- scanner ggshield non authentifié.

Ces limites doivent être levées avec une cible nommée et une autorisation explicite. Le prompt d'exécution détaillé se trouve dans `docs/ULTRA_MEGA_PROMPT_P0.md`.
