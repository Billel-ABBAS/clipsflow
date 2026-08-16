# Gestion des secrets

## Classification

Variables publiques, intégrées au navigateur :

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_CLIPS_ENABLED`

Secrets serveur :

- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CRON_SECRET`
- clés des fournisseurs d'IA ou de traduction
- identifiants d'envoi d'e-mail ou d'observabilité donnant un accès privilégié

Le préfixe `NEXT_PUBLIC_` signifie que la valeur est publique. Une clé de service ou un secret fournisseur ne doit jamais porter ce préfixe.

## Règles

- Ne jamais copier un secret dans Git, un ticket, un chat, une capture d'écran, un journal ou une URL.
- Ne jamais passer un secret comme argument CLI : les arguments peuvent rester dans l'historique ou la liste des processus.
- Utiliser `.env.local` uniquement sur la machine de développement ; ce fichier reste ignoré par Git.
- Utiliser le gestionnaire de secrets Vercel ou celui de la plateforme pour preview/staging/production.
- Séparer les identifiants Stripe test et live.
- Donner à chaque environnement son propre secret de webhook et son propre `CRON_SECRET`.
- Ne jamais utiliser `SUPABASE_SERVICE_ROLE_KEY` dans du code client.
- Les logs doivent contenir des codes stables et des identifiants non sensibles, pas les réponses brutes des fournisseurs.

## Injection sûre

Pour le local, saisir les valeurs dans `.env.local` avec un éditeur local. Pour une plateforme, utiliser son interface de secrets ou une commande interactive qui lit depuis l'entrée standard. Ne mettez pas la valeur dans la commande, dans un script versionné ou dans une documentation.

Le script `pnpm run stripe:setup:test` lit `STRIPE_SECRET_KEY` depuis l'environnement du processus, refuse les clés live et reste en dry-run sans `--apply`. Il n'obtient et n'affiche jamais de secret de webhook.

## Rotation

1. Identifier précisément le secret et tous ses consommateurs.
2. Créer une nouvelle valeur dans le fournisseur concerné.
3. Enregistrer la nouvelle valeur dans le gestionnaire de secrets de chaque environnement autorisé.
4. Redéployer et vérifier les parcours dépendants.
5. Révoquer l'ancienne valeur.
6. Surveiller les erreurs et l'utilisation anormale.

Si un secret a pu apparaître dans Git, le retirer du dernier commit ne suffit pas : le considérer compromis, le révoquer, puis traiter l'historique selon une procédure coordonnée.

## Contrôles avant livraison

- vérifier que `.env*` sensible n'est pas suivi par Git ;
- rechercher les formes de clés privées à forte entropie dans les fichiers suivis et l'historique ;
- inspecter les diffs pour les URLs contenant utilisateur, mot de passe, paramètres ou fragments sensibles ;
- exécuter le scanner de secrets de l'organisation lorsqu'il est authentifié ;
- vérifier que les tests n'utilisent que des valeurs factices courtes et explicitement invalides.

Un scanner non authentifié ou indisponible ne doit jamais être présenté comme une preuve d'absence de secret : documenter la limite et compléter par une recherche locale qui n'affiche que les chemins concernés.
