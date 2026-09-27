# Configuration Stripe sûre

Le flux par défaut est le mode test. La production Stripe live est une opération distincte qui exige l'approbation explicite de la cible, des prix, du domaine et du webhook.

## 1. Préconditions

- migrations de facturation et migration P0 appliquées sur l'environnement visé ;
- `NEXT_PUBLIC_APP_URL` configuré sur l'origine HTTPS exacte en staging/production ;
- `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` stockés côté serveur uniquement ;
- identifiants de prix stockés dans `STRIPE_PRICE_ID_SOLO`, `STRIPE_PRICE_ID_PRO` et `STRIPE_PRICE_ID_STUDIO` ;
- clé publiable éventuelle dans `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

Ne jamais coller une clé ou un secret dans une commande, un document, un ticket ou un chat.

## 2. Produits et prix de test

Afficher le plan de création sans appeler Stripe :

```powershell
pnpm run stripe:setup:test
```

Après injection sûre d'une clé privée Stripe test dans l'environnement du processus, appliquer explicitement :

```powershell
pnpm run stripe:setup:test -- --apply
```

Le script :

- refuse toute clé live ;
- ne modifie rien sans `--apply` ;
- retrouve les produits grâce à `metadata.clipsflow_plan` ;
- réutilise un prix mensuel USD identique ;
- emploie des clés d'idempotence pour les créations ;
- affiche uniquement les identifiants de prix non secrets ;
- ne crée et n'affiche aucun secret de webhook.

## 3. Webhook de test

Dans Stripe Dashboard, créer un endpoint dont l'URL est l'origine configurée suivie de `/api/billing/webhook`. Activer au minimum :

- `checkout.session.completed` ;
- `customer.subscription.created` ;
- `customer.subscription.updated` ;
- `customer.subscription.deleted` ;
- `invoice.payment_failed`.

Enregistrer le secret de signature directement dans le gestionnaire de secrets de l'environnement. Chaque endpoint et chaque environnement possèdent leur propre secret.

## 4. Vérifications

1. Créer une Checkout Session test depuis l'application.
2. Confirmer que les redirections succès/annulation restent sur l'origine configurée.
3. Vérifier que la session associe l'utilisateur et que le prix réellement présent dans l'abonnement détermine le plan.
4. Rejouer un événement terminé : il doit être ignoré sans double effet.
5. Provoquer un échec contrôlé, corriger la cause, puis rejouer : l'événement doit pouvoir réussir.
6. Envoyer un événement plus ancien après un événement récent : il ne doit pas faire régresser le profil.

## 5. Passage en live

Ne réutiliser aucun objet, secret ou webhook de test. Faire approuver séparément les montants, devises, identifiants de prix, domaine public, événements et plan de retour arrière. Configurer les secrets live directement sur la plateforme, déployer d'abord en preview/staging lorsque le parcours le permet, puis exécuter une transaction live minimale autorisée.

Le script fourni refuse volontairement le mode live. Une automatisation live nécessiterait une revue et une autorisation dédiées ; elle ne doit pas être obtenue en retirant simplement le garde-fou.
