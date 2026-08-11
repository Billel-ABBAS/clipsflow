# ClipsFlow — Secrets Management

Ce qui doit être gardé **hors du repo** et comment les gérer.

## Fichier sensible actuel

`.env.local` (gitignored) contient actuellement en **LIVE** :

- Stripe : `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_SOLO/PRO/STUDIO`
- Supabase : `SUPABASE_SERVICE_ROLE_KEY`
- Supabase : `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- Cron : `CRON_SECRET`

## ⚠️ Règles absolues

1. **Jamais dans le chat** : ne colle `.env.local` dans aucun message (ni dans les issues, PR, screenshots)
2. **Jamais committé** : `.env.local` est dans `.gitignore` — vérifier avec `git status` avant `git push`
3. **Jamais dans les logs** : pas de `console.log(process.env.STRIPE_SECRET_KEY)`
4. **R2** : toutes les clés sont LIVE — un leak = incident financier direct

## Rotation (si leak suspecté)

1. **Stripe Dashboard** → Developers → API keys → Regenerate (immediat, invalide l'ancien)
2. **Stripe Dashboard** → Webhooks → ton endpoint → Regenerate signing secret
3. **Supabase Dashboard** → Settings → API → Reset service_role
4. **Groq/OpenAI/Anthropic** : revoke dans leurs consoles respectives
5. **Update** : `.env.local` + `vercel env rm` + `vercel env add`

## Vérification hebdomadaire (1 min)

```bash
# Vérifie que .env.local n'est jamais committé
git check-ignore .env.local  # doit retourner ".env.local"

# Vérifie qu'aucun secret n'est dans le code source
git grep -n "sk_live\|whsec\|eyJhbGc" -- "src/**"  # doit ne rien retourner
```

## Accès production

- Vercel env vars : https://vercel.com/dashboard → clipsflow → Settings → Environment Variables
- Stripe live : https://dashboard.stripe.com/live/apikeys
- Supabase : https://supabase.com/dashboard/project/luympnrbthbcgbemxykp/settings/api

## ggshield (secret scan)

Hook pre-commit existant (`.husky/pre-commit`) scanne les secrets. Pour activer le gate strict :

```bash
.venv\Scripts\activate.ps1   # ou équivalent si ggshield installé autrement
ggshield auth login
# Une fois authentifié une fois, les commits seront bloqués si un secret est détecté
```
