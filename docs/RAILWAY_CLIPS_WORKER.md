# Worker vidéo ClipsFlow sur Railway

Le site reste sur son hébergement actuel. Ce document ne décrit que le worker
one-shot `pnpm worker:clips` : il réclame au plus un rendu, ferme ses
connexions et termine. Railway Cron le relance au plus tôt toutes les cinq
minutes ; un lancement peut être décalé de quelques minutes et Railway ignore
le suivant si le précédent est encore actif.

## État Railway constaté le 22 septembre 2026

- `powerful-magic` / `web` (Nutrisnap), `unique-achievement` / `AO-France`
  et `brave-balance` / `@cadence/jobs` ont été supprimés après confirmation
  explicite. Les trois projets conteneurs sont conservés et affichent
  `No services`.
- `brave-victory` / `cal-halal` et `lively-wisdom` / `Calpyra-AI` n'ont pas
  été modifiés et affichent toujours `1/1 service online`.

## Garde-fous intégrés

- `clips_claim_render_job` crée un bail renouvelable de dix minutes.
- Les MP4 et VTT Railway sont rangés sous
  `{user}/{clip}/attempts/{lease}.ext`; une ancienne tentative n'écrase jamais
  une reprise.
- Les RPC de renouvellement, succès et échec sont `service_role` uniquement,
  avec `search_path` vide. Le succès et le remboursement terminal sont des
  transactions clôturées par le même jeton de bail.
- `CLIPS_WORKER_ENABLED=false` bloque les nouvelles demandes avec un état
  lisible avant toute réservation de quota. Le worker se termine aussi sans
  travail lorsqu'il est désactivé.
- `CLIPS_AI_BUDGET_AUTHORIZED` est `false` par défaut : aucun média n'est
  envoyé à Groq ou OpenAI tant qu'un budget n'a pas été approuvé.

## Préparation d'un environnement de test autorisé

1. Publier un commit issu de `fix/p0-security-hardening`, jamais l'ancien
   `main`, dans une branche de test revue.
2. Créer le projet Railway `clipsflow` et son unique service `clips-worker`.
   Utiliser `Dockerfile.worker`, la commande `pnpm worker:clips`, aucun domaine
   public et aucun volume.
3. Régler Railway Cron sur `*/5 * * * *` (UTC), une réplique, au plus 1 vCPU
   et 1 Go de mémoire. Ne pas créer de règle de coupure globale du workspace.
4. Saisir dans Railway, sans les mettre dans Git, les variables déjà présentes
   dans l'environnement de test : `NEXT_PUBLIC_SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, et seulement les clés IA dont le test a besoin.
   Les clés restent des secrets Railway; elles ne doivent jamais être affichées
   dans les logs ou cette documentation.
5. Ajouter les variables non secrètes suivantes :

   ```text
   CLIPS_WORKER_ENABLED=false
   CLIPS_AI_BUDGET_AUTHORIZED=false
   CLIPS_MAX_SOURCE_BYTES=209715200
   CLIPS_FFMPEG_TIMEOUT_MS=300000
   CLIPS_BURN_PNG_OVERLAY=0
   ```

6. Après autorisation explicite du projet Supabase de test, appliquer la
   migration `20260922153033_railway_render_worker_leases.sql` et vérifier les
   grants des quatre RPC. Garder le worker désactivé tant que cette étape n'est
   pas confirmée.

## Vérification de mise en service

1. Activer temporairement `CLIPS_WORKER_ENABLED=true` sur Railway avec une
   file vide : le log doit indiquer `worker_complete` / `empty` et le
   conteneur doit s'arrêter. Garder la même variable désactivée sur le site
   tant que ce test n'est pas validé, afin qu'aucun utilisateur ne réserve de
   quota pendant la mise au point.
2. Mesurer ce lancement vide, puis un clip représentatif. N'autoriser
   `CLIPS_AI_BUDGET_AUTHORIZED=true` que pour ce test de budget explicitement
   accepté.
3. Vérifier MP4, VTT, transcription, sous-titres et watermark du forfait dans
   la galerie. Tester interruption/reprise, URL lente, fichier trop gros,
   timeout FFmpeg et nettoyage des fichiers temporaires.
4. Pour la production seulement après ces preuves : activer
   `CLIPS_WORKER_ENABLED=true` côté site, déployer le garde de coupure, définir
   `CLIPS_WORKER_BACKEND=railway` côté Vercel, puis supprimer le cron Vercel
   dans un déploiement suivant. Cela évite tout double drain.
5. Les trois anciens services Railway sont déjà supprimés comme indiqué plus
   haut. Calpyra-AI et Cal-Halal restent hors de ce projet et ne doivent pas
   être modifiés.
