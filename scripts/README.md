# Scripts d'exploitation

## `setup-stripe-test.mjs`

Prépare de façon idempotente les produits et prix Stripe en mode test.

- Dry-run par défaut : `pnpm run stripe:setup:test`
- Mutation test explicite : `pnpm run stripe:setup:test -- --apply`
- Refuse les clés live et les arguments inconnus.
- Lit la clé depuis l'environnement, sans jamais l'afficher.
- Ne crée et ne révèle aucun secret de webhook.

## `test-webhook-e2e.mjs`

Smoke test destructif local du webhook Stripe signé.

- Exige l'unique argument `--apply`.
- Exige `ALLOW_LOCAL_MUTATION=1`.
- Refuse toute origine applicative ou Supabase qui n'est pas locale.
- Crée un utilisateur de test temporaire et tente toujours de le supprimer.
- N'affiche que des codes d'erreur sûrs.

## `check-i18n-clips.mjs`

Vérifie les clés de traduction attendues par l'interface ClipsFlow.

Les anciens scripts Python qui ouvraient le Dashboard Stripe ou créaient directement des produits ont été retirés. Utiliser le script test protégé et la procédure de [configuration Stripe](../docs/STRIPE_SETUP.md).
