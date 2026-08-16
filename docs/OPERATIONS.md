# Runbook d'exploitation ClipsFlow

Ce runbook est volontairement prudent. Les commandes sans cible explicite servent à vérifier le dépôt local. Toute mutation distante exige une cible confirmée, une sauvegarde et une autorisation distincte.

## 1. Prévol obligatoire

Depuis la racine du dépôt :

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm audit --prod --audit-level high
git diff --check
```

Vérifier ensuite, sans afficher de secret :

- la branche et le commit à déployer ;
- l'environnement visé : local, preview, staging ou production ;
- la référence Supabase extraite du nom d'hôte de `NEXT_PUBLIC_SUPABASE_URL` ;
- la référence du projet lié par la CLI ;
- le projet et l'équipe Vercel ;
- le mode Stripe, test ou live ;
- l'existence d'une sauvegarde Postgres récente et restaurable.

Arrêter immédiatement si une référence, un domaine, une équipe ou un mode ne correspond pas. Une session CLI déjà connectée ne constitue pas une preuve de cible.

## 2. Vérification locale de la base

Docker doit fonctionner. Ces commandes ne ciblent que Supabase local :

```powershell
pnpm dlx supabase@latest db reset --local --no-seed
pnpm dlx supabase@latest db lint --local --level error --fail-on error
```

Exécuter ensuite `supabase/tests/p0_security.sql` contre le Postgres local. Le fichier vérifie les privilèges, la RLS forcée, l'atomicité des soumissions, le rate limit et la reprise Stripe.

Avant une migration distante, consulter la liste et le SQL prévu. Utiliser le mode dry-run de la version installée de Supabase CLI quand il est disponible. Ne lancer aucun `db push` tant que la cible et la sauvegarde n'ont pas été validées par l'opérateur.

## 3. Ordre de déploiement

1. Créer et vérifier une sauvegarde de la base visée.
2. Appliquer les migrations jusqu'à `20260816133249_p0_security_hardening.sql`.
3. Vérifier les RPC, privilèges et politiques RLS sur la cible.
4. Configurer les variables serveur et publiques dans le gestionnaire de secrets de l'environnement.
5. Déployer l'application sur un environnement de prévisualisation ou de staging.
6. Exécuter les smoke tests authentification, upload, soumission, cron, watermark et facturation test.
7. Configurer ou confirmer le webhook Stripe vers `/api/billing/webhook` et ses événements.
8. Promouvoir en production seulement après validation de la prévisualisation.

La migration P0 est additive pour les tables et RPC, mais retire des privilèges directs aux rôles navigateur. Le code compatible RPC doit donc être prêt au moment de son application.

## 4. Contrôles après déploiement

- la page d'accueil et la route d'authentification répondent ;
- les redirections OAuth restent sur l'origine applicative ;
- un utilisateur ne peut lire que ses objets ;
- une soumission valide crée exactement un clip et un job ;
- un dépassement de débit renvoie `429` avec `Retry-After` ;
- une indisponibilité du limiteur renvoie `503`, sans autoriser la requête ;
- un quota insuffisant renvoie `402` ;
- un plan gratuit produit un clip watermarké ;
- un échec de watermark fait échouer le job et rembourse le quota ;
- un webhook Stripe signé est traité une fois, relançable après échec et protégé contre les événements plus anciens ;
- les erreurs Sentry ne contiennent ni e-mail, ni jeton, ni paramètres d'URL sensibles.

## 5. Incidents usuels

### Jobs bloqués

Inspecter les jobs `pending` ou `processing`, leur ancienneté, le dernier code d'erreur sûr et les journaux du cron. Ne modifier pas directement le plan ou le quota. Corriger la cause, puis utiliser le mécanisme normal de reprise ou une opération SQL revue et limitée à l'incident.

### Limitation de débit

- `429` : fenêtre consommée ; attendre la valeur `Retry-After`.
- `402` : quota fonctionnel du plan, distinct du rate limit.
- `503` : stockage du limiteur indisponible ; investiguer Postgres/RPC. Le système échoue fermé.

### Webhook Stripe

Consulter l'événement dans Stripe et l'état correspondant dans `stripe_webhook_events`. Un état `failed` peut être rejoué depuis Stripe après correction. Ne marquer jamais manuellement l'événement `completed` et ne mettre jamais à jour `profiles.plan` pour masquer le problème.

### Sortie réseau refusée

Un refus `invalid_url`, `host_not_allowed`, `private_address` ou `redirect_limit` indique une protection SSRF. Corriger l'URL ou l'allowlist exacte ; ne désactivez pas la validation globale.

## 6. Retour arrière

1. Stopper la promotion et conserver les traces de l'incident.
2. Revenir au dernier déploiement applicatif sain depuis la plateforme de déploiement.
3. Ne supprimer ni table ni colonne de la migration P0 pendant l'incident.
4. Si le code précédent dépendait des anciens privilèges navigateur, déployer plutôt un correctif avant de réaccorder un privilège sensible.
5. Restaurer la base seulement si l'intégrité des données est compromise et après validation explicite de la sauvegarde et de la perte potentielle de données.
6. Rejouer les webhooks Stripe échoués après restauration de l'application.

## 7. Discipline des changements distants

Les opérations de production, la rotation de secrets, la modification d'un webhook live et toute restauration sont des mutations externes. Elles nécessitent une autorisation explicite sur la cible nommée. Les procédures ne doivent contenir ni domaine historique, ni identifiant de projet copié, ni secret en argument de ligne de commande.
