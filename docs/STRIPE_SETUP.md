# ClipsFlow — Stripe Setup Guide

Ce guide te permet de créer les produits et prix Stripe en mode test, et de configurer ClipsFlow pour le billing.

## Prérequis

- Compte Stripe : https://dashboard.stripe.com (crée un compte si tu n'en as pas)
- Mode **Test** activé (toggle en haut à gauche)

---

## Étape 1 : Créer les 3 produits + prix

Dans Stripe Dashboard → **Products** → **Add product** :

### 1. Solo — $29/mois
- **Name** : Solo
- **Description** : 8 minutes of clips/month, pro subtitle styles, no watermark
- **Price** : $29.00 USD
- **Billing period** : Monthly
- **Price ID** : copie le `price_...` → `STRIPE_PRICE_ID_SOLO`

### 2. Pro — $79/mois
- **Name** : Pro
- **Description** : 30 minutes of clips/month, all styles + custom colors, no watermark
- **Price** : $79.00 USD
- **Billing period** : Monthly
- **Price ID** : copie le `price_...` → `STRIPE_PRICE_ID_PRO`

### 3. Studio — $199/mois
- **Name** : Studio
- **Description** : 60 minutes of clips/month, everything unlocked, all positions + animations
- **Price** : $199.00 USD
- **Billing period** : Monthly
- **Price ID** : copie le `price_...` → `STRIPE_PRICE_ID_STUDIO`

---

## Étape 2 : Créer le webhook endpoint

Dans Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint** :

- **Endpoint URL** : `https://clipsflow-liart.vercel.app/api/billing/webhook`
- **Events to send** :
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
- **Signing secret** : copie le `whsec_...` → `STRIPE_WEBHOOK_SECRET`

---

## Étape 3 : Récupérer les clés API

Dans Stripe Dashboard → **Developers** → **API keys** :

- **Publishable key** (`pk_test_...`) → `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- **Secret key** (`sk_test_...`) → `STRIPE_SECRET_KEY`

**⚠️ Jamais ces clés dans le chat ni dans le repo — garde-les en local sécurisé.**

---

## Étape 4 : Configurer .env.local

Édite `C:\Users\adama\Documents\Projet_Applications\ClipsFlow\.env.local` :

```env
STRIPE_SECRET_KEY=sk_test_TA_VRAIE_CLE_ICI
STRIPE_WEBHOOK_SECRET=whsec_TA_VRAIE_CLE_ICI
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_TA_VRAIE_CLE_ICI
STRIPE_PRICE_ID_SOLO=price_TA_VRAIE_PRICE_SOLO_ICI
STRIPE_PRICE_ID_PRO=price_TA_VRAIE_PRICE_PRO_ICI
STRIPE_PRICE_ID_STUDIO=price_TA_VRAIE_PRICE_STUDIO_ICI
```

---

## Étape 5 : Tester le flow complet

1. **Va sur** https://clipsflow-liart.vercel.app/pricing
2. Clique **Upgrade to Solo** (ou Pro/Studio)
3. Sur la page Stripe Checkout, utilise la carte test :
   - **Numéro** : `4242 4242 4242 4242`
   - **Expiration** : n'importe quelle date future
   - **CVC** : n'importe quel 3 chiffres
   - **ZIP** : n'importe quel code
4. Termine le paiement
5. Retourne sur https://clipsflow-liart.vercel.app/clips
6. **Vérifie** le quota : tu devrais voir `XX / 480 seconds` (Solo)
7. **Crée un clip** → pas de watermark Solo

---

## Étape 6 : Passer en live (optionnel)

Quand tu es prêt à vendre réellement :

1. Dans Stripe Dashboard, toggle en mode **Live**
2. Recrée les 3 produits + prix en mode Live
3. Recrée le webhook en Live
4. Remplace les env test par les env live (mêmes noms, valeurs live)
5. Redéploie : `vercel --prod`

**⚠️ La règle Stripe est : test mode d'abord, puis bascule live une fois validée.**

---

## Support en cas de problème

- **Webhook 400** : vérifie `STRIPE_WEBHOOK_SECRET` = exact match depuis webhook Stripe
- **Checkout 404** : vérifie `STRIPE_PRICE_ID_*` (test, commence par `price_`)
- **Pas de plan upgrade** : vérifie la table `profiles` en Supabase → `plan` doit être `solo/pro/studio` après webhook

---

Une fois les clés Stripe test récupérées, dis-moi et je te pousse tout sur Vercel. On peut aussi activer Stripe avec les vraies clés maintenant si tu veux.
