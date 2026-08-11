# Operations Runbook — ClipsFlow

Guide rapide pour diagnostiquer et résoudre les incidents prod.

## Incidents courants

### 1. Stripe webhook ne met pas à jour le plan

**Symptôme** : user a payé, mais reste `plan='free'` dans Supabase.

**Diagnostic** :
```sql
-- Vérifier le profil
SELECT id, plan, stripe_customer_id, subscription_status
FROM profiles
WHERE id = 'user-uuid';

-- Vérifier que le webhook est bien reçu (logs Vercel)
```

**Fix** :
- Vérifier que `STRIPE_WEBHOOK_SECRET` dans Vercel = celui du webhook Stripe
- Vérifier la signature dans les logs : Stripe Dashboard → Webhooks → essais de livraison
- Forcer manuellement : UPDATE profiles SET plan = 'solo' WHERE stripe_customer_id = 'cus_...'

### 2. Cron process-clips ne tourne pas

**Symptôme** : clips restent en 'pending' indéfiniment.

**Diagnostic** :
- Vercel Dashboard → Crons → vérifier que `process-clips` est listé et actif
- Logs Vercel : filtrer par `api/cron/process-clips`

**Fix** :
- Redéployer : `vercel --prod`
- Vérifier que `CRON_SECRET` est bien posé dans Vercel env (Production)

### 3. Erreurs Sentry ne remontent pas

**Symptôme** : aucun événement dans Sentry.io malgré des erreurs.

**Diagnostic** :
- Vérifier que `NEXT_PUBLIC_SENTRY_DSN` est posé en production dans Vercel env
- Vérifier `sentry.server.config.ts` : `dsn` est bien lu depuis `process.env.NEXT_PUBLIC_SENTRY_DSN`

**Fix** :
- Ajouter la clé dans Vercel env : `vercel env add NEXT_PUBLIC_SENTRY_DSN production --value "https://...@sentry.io/..." --yes`
- Redéployer

### 4. Quota dépassé (429)

**Symptôme** : user reçoit `{"error":"clip_quota_exceeded"}` alors qu'il a payé.

**Diagnostic** :
- Vérifier que `profiles.plan = 'solo'` (ou pro/studio) après le paiement
- Vérifier `clip_seconds_used_this_month` : si élevé, le quota est réellement épuisé

**Fix** :
- Si c'est un faux positif (Stripe a mis à jour), voir incident #1
- Sinon, l'utilisateur doit attendre le reset mensuel ou upgrader

### 5. Upload échoue ("source_too_large")

**Symptôme** : user upload une vidéo, erreur "file too large".

**Diagnostic** :
- Taille actuelle : max 500 MB (configuré dans migration 0002)

**Fix** :
- Demander à l'utilisateur de compresser (Handbrake) ou réduire la résolution
- Ou augmenter la limite dans la migration (pas recommandé — coût Supabase Storage)

## Health check rapide

```bash
# 1. Site répond ?
curl -I https://clipsflow-liart.vercel.app/en

# 2. API billing reachable ?
curl -I https://clipsflow-liart.vercel.app/api/billing/checkout

# 3. DB Supabase reachable ?
curl -H "apikey: $SUPABASE_ANON_KEY" https://luympnrbthbcgbemxykp.supabase.co/rest/v1/profiles?limit=1
```

## Logs utiles

| Où | Quoi |
|----|------|
| Vercel Functions | `api/clips/jobs`, `api/billing/checkout`, `api/billing/webhook` |
| Supabase Logs | `postgres` (queries lentes), `storage` (uploads) |
| Stripe Dashboard | `checkout.session.completed`, `customer.subscription.updated` |
