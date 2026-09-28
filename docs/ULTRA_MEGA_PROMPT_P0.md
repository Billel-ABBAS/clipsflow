# Ultra méga prompt — finaliser, déployer et améliorer ClipsFlow

Copier le bloc suivant dans une nouvelle tâche Codex disposant du bon profil d'exécution.

---

Tu es l'ingénieur principal responsable de finaliser ClipsFlow jusqu'à un état vérifié et exploitable. Travaille dans le dépôt ClipsFlow fourni par le workspace. Prends en charge le terminal, les outils locaux et le navigateur uniquement dans la portée ci-dessous. Ne demande pas à l'utilisateur d'exécuter les commandes que tu peux exécuter toi-même.

## Configuration d'exécution requise

- profil filesystem : `workspace-write` au minimum ;
- approbations : `on-request` ;
- réseau : autorisable ;
- Docker disponible pour Supabase local ;
- accès Chrome autorisé pour les parcours de preview/staging ;
- aucun secret dans les messages, commandes, captures ou logs.

Confirme au début : « J'applique d'abord le lot P0 sécurité/stabilité production avant tout refactor et toute amélioration UX. » Si le profil ne permet pas les écritures workspace, les demandes d'approbation ou le réseau autorisable, arrête-toi et explique exactement quel réglage manque.

## État de départ à vérifier, jamais à supposer

- branche attendue : `fix/p0-security-hardening` ;
- worktree historique : `.worktrees/p0-security-hardening` ;
- rapport : `docs/reports/2026-08-16-P0_SECURITY_AUDIT.md` ;
- architecture : `docs/ARCHITECTURE.md` ;
- runbook : `docs/OPERATIONS.md` ;
- plan d'origine : `docs/superpowers/plans/2026-08-16-p0-security-hardening.md` ;
- migration P0 : `supabase/migrations/20260816133249_p0_security_hardening.sql` ;
- tests SQL : `supabase/tests/p0_security.sql`.

Commence par `git status`, `git branch --show-current`, `git log --oneline`, la lecture des instructions `AGENTS.md` éventuelles et la lecture des documents ci-dessus. Préserve toutes les modifications utilisateur. Ne réinitialise, ne supprime et ne déplace rien de large. Si la branche a évolué, audite le diff réel plutôt que de faire confiance à ce prompt.

## Règles non négociables

1. Ne touche jamais une cible distante tant que son identité n'est pas prouvée.
2. La référence Supabase attendue doit être extraite du nom d'hôte de `NEXT_PUBLIC_SUPABASE_URL` sans afficher la valeur complète ni aucune clé. Elle doit correspondre exactement au projet lié par l'outil qui effectuera la mutation.
3. Si les références ne correspondent pas, aucune migration, requête SQL, suppression, déploiement ou modification d'auth ne doit être faite sur ce projet.
4. Ne lis pas et n'affiche pas les valeurs de `.env.local`. Limite-toi à vérifier la présence des noms nécessaires et à comparer des identifiants non secrets dérivés.
5. Ne passe jamais une clé en argument CLI. Utilise les stores de secrets, les prompts sécurisés ou l'environnement du processus déjà configuré.
6. Stripe test et Stripe live sont deux cibles distinctes. Aucune mutation live sans approbation explicite mentionnant « Stripe live ».
7. N'applique aucune migration distante sans sauvegarde confirmée et plan de retour arrière.
8. Ne marque jamais un finding « corrigé » sans test frais qui reproduit le risque ou vérifie la fermeture du chemin.
9. Échoue fermé pour l'autorisation, le rate limit, le watermark, la validation d'origine et les sorties réseau.
10. Ne commence les refactors/UX qu'après la réussite et la stabilité du lot P0.

## Mission A — réaudit P0 du code réel

Revalide tous les invariants suivants dans le diff courant :

- RLS activée et forcée sur `profiles`, `episodes`, `clips`, `jobs` ;
- rôles `anon`/`authenticated` sans mutation directe du cycle de vie ;
- profil utilisateur limité à `email`, `full_name`, `locale` ;
- soumission clip/job/quota atomique via `clips_submit_job` ;
- rate limit distribué sur jobs, transcribe, upload-init et checkout ;
- erreurs du limiteur en `503`, dépassements en `429` avec `Retry-After` ;
- origine unique `NEXT_PUBLIC_APP_URL`, HTTPS en production, `next` relatif sûr ;
- Checkout et customer Stripe idempotents ;
- plan dérivé du price ID réellement présent dans l'abonnement ;
- événements Stripe revendiqués, terminés/échoués, relançables et appliqués dans l'ordre ;
- toutes les sorties média/logo utilisent `safeFetch` ou un chemin local ;
- HTTPS, port, identifiants URL, IP privées/réservées, DNS et redirections contrôlés ;
- Sentry expurge e-mails, tokens, clés, credentials, query strings et fragments ;
- watermark obligatoire pour plan gratuit ou inconnu, sans fail-open ;
- scripts Stripe live dangereux absents ; setup test en dry-run et E2E webhook strictement local ;
- aucune vulnérabilité connue dans `pnpm audit` complet et production.

Pour chaque écart : reproduis d'abord par un test minimal qui échoue, apporte le plus petit correctif fermant la cause racine, puis fais passer le test. Ne remplace pas une protection structurelle par un filtre cosmétique.

## Mission B — validation locale complète

Exécute avec des sorties fraîches :

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm audit --audit-level moderate
pnpm audit --prod --audit-level moderate
git diff --check
```

Puis, avec Docker :

```powershell
pnpm dlx supabase@latest start
pnpm dlx supabase@latest db reset --local --no-seed
pnpm dlx supabase@latest db lint --local --level error --fail-on error
```

Exécute `supabase/tests/p0_security.sql` contre le Postgres local sans imprimer les clés locales. Vérifie aussi :

- syntaxe et dry-run de `scripts/setup-stripe-test.mjs` ;
- refus de `scripts/test-webhook-e2e.mjs` sans `--apply` ;
- absence de secret à forte entropie dans les fichiers suivis et l'historique, en n'affichant que les chemins ;
- état du scanner institutionnel. S'il n'est pas authentifié, considère la gate comme non validée.

Ne poursuis pas vers le distant tant qu'un test, audit, lint, typecheck, build, test SQL ou contrôle de secret obligatoire échoue.

## Mission C — prévol distant et demande d'approbation

Sans mutation :

1. Identifie l'environnement demandé : preview, staging ou production.
2. Compare la référence Supabase configurée et la cible liée.
3. Vérifie l'équipe/projet Vercel et le domaine attendu.
4. Vérifie le mode Stripe et les identifiants de prix, sans afficher de secret.
5. Vérifie l'existence et la date d'une sauvegarde restaurable.
6. Affiche le plan exact des mutations : migration, variables, déploiement, webhook, smoke tests et rollback.

Demande une approbation `on-request` séparée pour chaque classe de mutation importante. Si la cible disponible ne correspond pas, arrête la phase distante et donne la commande ou le geste minimal permettant à l'utilisateur de relier la bonne cible ; ne contourne pas le mismatch.

## Mission D — déploiement contrôlé après approbation

Ordre obligatoire :

1. confirmer la sauvegarde ;
2. afficher/dry-run le SQL de migration ;
3. appliquer les migrations jusqu'à la migration P0 ;
4. vérifier ACL, RLS, fonctions et tests de sécurité adaptés à la cible ;
5. configurer les variables par le gestionnaire de secrets ;
6. déployer une preview/staging ;
7. exécuter les smoke tests ;
8. configurer/confirmer le webhook Stripe test ;
9. promouvoir en production seulement avec une nouvelle approbation explicite ;
10. observer les métriques et journaux après promotion.

Ne crée pas de prix live automatiquement. Le script `stripe:setup:test` refuse volontairement le live. Ne retire jamais ce garde-fou pour aller plus vite.

## Mission E — parcours Chrome de preview/staging

Utilise Chrome sur l'origine explicitement autorisée. N'enregistre pas de mot de passe ou secret dans le rapport.

Parcours minimal :

1. page d'accueil, langues et pricing ;
2. OAuth/login et redirection interne ;
3. création de deux comptes de test et vérification d'isolation ;
4. upload d'un petit média autorisé ;
5. soumission et polling du job ;
6. rendu gratuit avec watermark visible ;
7. erreur de rate limit lisible et reprise ;
8. Checkout Stripe test et retour succès/annulation ;
9. webhook test : activation du plan, doublon, échec/rejeu, événement obsolète ;
10. portail client test ;
11. contrôle réseau et console navigateur sans fuite de données.

Supprime uniquement les comptes et artefacts explicitement créés pour ce test, avec une cible locale/staging vérifiée.

## Mission F — améliorations P1/P2 après feu vert P0

Ne commence cette mission qu'après réussite de A à E et confirmation de stabilité.

Priorité P1 :

- fermer le risque DNS rebinding par egress proxy ou résolution épinglée avec TLS/SNI correct ;
- automatiser la rétention bornée de `api_rate_limits` et `stripe_webhook_events` ;
- réconcilier les uploads/épisodes orphelins avec délai de grâce ;
- ajouter alertes sur jobs bloqués, refunds, watermark, rate limiter et webhooks échoués ;
- rendre ggshield ou un équivalent authentifié obligatoire en CI ;
- ajouter tests E2E Playwright pour auth simulée, upload, jobs et billing test ;
- durcir la Content Security Policy et les headers après inventaire des domaines réellement requis.

Priorité P2 UX/produit :

- audit clavier, focus, lecteur d'écran, contrastes et reduced-motion ;
- reprise d'upload, progression explicite et messages d'erreur localisés ;
- statut de job plus clair et stratégie de retry/polling mesurée ;
- mesure Web Vitals avant toute optimisation ;
- factorisation des cartes pricing/landing sans changer les contrats métier ;
- tableau d'état facturation et récupération self-service via le portail.

Pour chaque amélioration, écris un test ou une mesure de référence avant de modifier le code. Évite les refactors massifs non liés et conserve des commits petits, cohérents et réversibles.

## Critères d'acceptation

Le travail n'est terminé que si :

- le worktree est propre ou chaque modification restante est expliquée ;
- tous les tests et audits locaux sont verts avec preuves fraîches ;
- les tests SQL passent sur la base locale reconstruite ;
- zéro vulnérabilité connue est rapportée au seuil modéré ;
- aucun secret réel n'est détecté par les contrôles disponibles ;
- aucune cible distante incorrecte n'a été mutée ;
- les mutations approuvées sont listées avec cible et résultat ;
- le parcours Chrome autorisé est documenté étape par étape ;
- les risques résiduels sont explicites, avec priorité et propriétaire ;
- un rollback concret existe pour application, base et Stripe ;
- tu n'affirmes jamais « production prête » si la migration, les secrets, le webhook, le smoke navigateur ou l'observabilité de production ne sont pas validés.

## Format du rapport final

Réponds en français, en commençant par le résultat réel. Inclus :

1. verdict : corrigé localement / prêt pour staging / prêt pour production ;
2. fichiers et commits principaux ;
3. tableau des commandes de vérification avec résultat exact ;
4. mutations distantes réalisées, avec cible, ou « aucune » ;
5. findings fermés et risques résiduels ;
6. preuves du parcours Chrome ;
7. actions manuelles minimales restantes ;
8. procédure de rollback ;
9. liens cliquables vers le rapport, la migration, les tests et le runbook.

Si une étape est bloquée, poursuis toutes les vérifications locales indépendantes possibles, puis rends le blocage précis. Ne demande jamais une clé dans le chat et ne transforme jamais une absence d'accès en validation implicite.

---
