# Smoke tests ClipsFlow

À exécuter d'abord en local, puis sur une preview ou un staging autorisé. Ne pas utiliser ce guide pour muter implicitement la production.

## Préconditions

- Node.js et pnpm disponibles ;
- Docker actif pour Supabase local ;
- FFmpeg fourni par la dépendance du projet ;
- `.env.local` complet sans aucune valeur commise ;
- migrations `0001_init.sql`, `0002_clips_schema.sql`, `0003_stripe_billing.sql` et `20260816133249_p0_security_hardening.sql` présentes.

## 1. Vérifications statiques

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm audit --prod --audit-level high
```

Résultat attendu : commandes réussies et aucune vulnérabilité de production haute ou critique.

## 2. Base locale

```powershell
pnpm dlx supabase@latest start
pnpm dlx supabase@latest db reset --local --no-seed
pnpm dlx supabase@latest db lint --local --level error --fail-on error
```

Exécuter `supabase/tests/p0_security.sql` dans le Postgres local. Résultat attendu : rollback complet d'une soumission invalide, privilèges sensibles refusés aux rôles navigateur, rate limit partagé, événement Stripe échoué relançable et état d'abonnement monotone.

## 3. Authentification et isolation

1. Créer deux utilisateurs de test distincts.
2. Vérifier que chacun ne voit que ses épisodes, clips et jobs.
3. Tenter de lire et de modifier les identifiants de l'autre utilisateur.
4. Tenter une modification directe de `plan`, `quota_minutes`, d'un job et d'un clip depuis le rôle authentifié.

Résultat attendu : accès croisé et mutations sensibles refusés. Seuls `email`, `full_name` et `locale` sont modifiables par l'utilisateur sur son profil.

## 4. Upload et soumission

1. Initialiser un upload supporté.
2. Envoyer le fichier vers l'URL signée.
3. Soumettre un job à partir de l'épisode créé.
4. Répéter la même soumission avec le même identifiant de requête.

Résultat attendu : l'épisode contient un `source_storage_path`, la soumission crée atomiquement un clip et un job, et une répétition réseau ne multiplie pas les écritures attendues.

Codes à vérifier :

- `400` requête invalide ;
- `401` absence de session ;
- `402` quota insuffisant ;
- `403` ressource n'appartenant pas à l'utilisateur ;
- `429` limite de débit atteinte avec `Retry-After` ;
- `503` limiteur indisponible, sans traitement de la requête.

## 5. Pipeline et watermark

1. Traiter un petit média de test via le cron authentifié.
2. Vérifier les transitions `pending` → `processing` → `succeeded`.
3. Avec un compte gratuit, inspecter le média généré et confirmer le watermark.
4. Simuler un échec du watermark dans un test contrôlé.

Résultat attendu : aucun clip gratuit ou au plan inconnu ne réussit sans watermark. En cas d'échec, le job devient `failed` et le quota réservé est remboursé.

## 6. SSRF et observabilité

Vérifier que les URLs non HTTPS, les ports non standards, les identifiants dans l'URL, les IP privées/réservées, les hôtes hors allowlist et les redirections vers ces cibles sont refusés. Vérifier qu'une erreur envoyée à Sentry expurge e-mail, jetons, clés, paramètres et fragments d'URL.

## 7. Stripe en mode test

Le script de configuration est un dry-run par défaut :

```powershell
pnpm run stripe:setup:test
```

Une création Stripe test exige une clé test injectée dans l'environnement du processus et l'argument explicite `--apply` :

```powershell
pnpm run stripe:setup:test -- --apply
```

Le test webhook destructif est limité à `localhost`/`127.0.0.1`, exige `ALLOW_LOCAL_MUTATION=1` et `--apply`, crée un utilisateur local temporaire puis le supprime :

```powershell
node scripts/test-webhook-e2e.mjs --apply
```

Ne jamais l'exécuter contre une URL distante. Résultat attendu : signature valide, mise à jour `pro/active`, événement terminé, utilisateur temporaire supprimé.

## 8. Nettoyage

Supprimer les objets de test créés dans l'environnement dédié et arrêter Supabase local avec `pnpm dlx supabase@latest stop`. Ne pas employer une commande de nettoyage globale contre une cible distante.
