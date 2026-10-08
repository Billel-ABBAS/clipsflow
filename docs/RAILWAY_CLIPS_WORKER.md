# Worker vidéo ClipsFlow sur Railway

Le site reste sur son hébergement actuel. Ce document ne décrit que le worker
one-shot `scripts/clips-worker.ts` : il réclame au plus un rendu, ferme ses
connexions et termine. Railway Cron le relance au plus tôt toutes les cinq
minutes ; un lancement peut être décalé de quelques minutes et Railway ignore
le suivant si le précédent est encore actif.

## Worker Shorts long format (code local, service non provisionné)

Le traitement des épisodes de 1 minute à 4 heures utilise une file distincte
et un processus one-shot distinct. En local, `pnpm worker:shorts-analysis`
charge `.env.local` s'il existe; le fichier n'est pas requis en staging ou en
production. Sur Railway, lancer directement
`node_modules/.bin/tsx scripts/shorts-analysis-worker.ts` et fournir les secrets
via les variables du service. Ne pas remplacer la commande du worker Clips
existant. Provisionner un second service Railway dédié, construit depuis
`Dockerfile.worker`, avec FFmpeg, puis régler sa commande de démarrage sur le
worker Shorts. Le code réclame au plus une analyse par lancement; planifier le
Cron selon la charge et la capacité du service.

Variables non secrètes de ce service :

```text
SHORTS_ANALYSIS_WORKER_ENABLED=false
SHORTS_MAX_SOURCE_BYTES=8589934592
CLIPS_AI_BUDGET_AUTHORIZED=false
CLIPS_VISUAL_ANALYSIS_ENABLED=false
```

Le site Vercel utilise aussi `SHORTS_ANALYSIS_WORKER_READY=false` comme garde
d'admission. Ne définir cette variable à `true` côté application web qu'après
avoir provisionné et déployé ce worker séparé, configuré son budget et ses
fournisseurs côté Railway, puis validé un smoke authentifié sans données
utilisateur. La variable n'active pas le worker et ne remplace pas
`SHORTS_ANALYSIS_WORKER_ENABLED=true` sur le service Railway. En son absence,
l'interface et l'API refusent de mettre une analyse en file.

Le quota mensuel est résolu par l'application web, pas par ce worker, via
`SHORTS_ANALYSIS_MONTHLY_SOURCE_SECONDS_FREE`, `_SOLO`, `_PRO` et `_STUDIO`.
Les valeurs sont des secondes de source et doivent être choisies selon l'offre
commerciale; l'absence de valeur bloque les nouvelles analyses, tandis que `0`
désactive volontairement l'analyse pour le plan concerné. Ne pas copier ces
valeurs dans le dépôt.

Configurer côté serveur les clés Supabase, Groq/OpenAI et, uniquement si le
mode audio + vidéo est validé, Gemini. Ne jamais recopier de secret dans Git ou
les logs. Le worker télécharge la source complète dans son espace temporaire;
un plafond applicatif de 8 Gio exige donc un disque temporaire de plus de 8 Gio
avec une marge adaptée aux extractions audio/vidéo et au nombre de traitements
simultanés. `SHORTS_MAX_SOURCE_BYTES` peut réduire cette taille, pas dépasser
8 Gio. Supabase Free plafonne la taille globale à 50 Mio; un plafond source de
8 Gio nécessite donc un projet Pro ou supérieur et une limite globale Storage
d'au moins 8 Gio. Les envois utilisent TUS, dont la limite documentée est de
50 Gio; le plafond applicatif reste volontairement plus bas. La configuration
locale aligne sa limite globale sur 8 Gio, mais la migration locale ne modifie
pas le réglage global du projet distant.

Le worker Clips peut préparer une direction créative à partir d’un Short déjà
sélectionné avec l’identifiant Anthropic officiel `claude-opus-5-5`, derrière
le flag serveur et l’autorisation explicite du budget fournisseur. L'identifiant
est fixé dans le code : aucun autre modèle Opus ne sera substitué. Les appels
réels demeurent fermés tant que le budget, le flag et la clé serveur ne sont pas
explicitement configurés. Le résultat validé est
mis en cache sous le lease de rendu; le rendu visuel reste assuré par les
templates FFmpeg allow-listés.

Variables du worker Clips (secrets à saisir uniquement dans l’environnement du
service, jamais dans ce document ni dans Git) :

```text
CLIPS_CREATIVE_DIRECTOR_ENABLED=false
CLIPS_CREATIVE_DIRECTOR_MODEL=
ANTHROPIC_API_KEY=<secret serveur>
CLIPS_AI_BUDGET_AUTHORIZED=false
```

Pour Docker local, Compose ne charge pas `.env.local` implicitement; si le
fichier contient déjà la clé Anthropic, passe-le explicitement avec
`docker compose --env-file .env.local -f compose.workers.yaml ...`. Les services
restent désactivés par défaut. La présence du code ou de la migration ne
signifie pas que ce service Railway ou une base distante est configuré.

## Worker de publication YouTube (code local, service non provisionné)

Les publications confirmées par le créateur utilisent une troisième file et le
processus one-shot `pnpm worker:youtube-publish`, qui charge `.env.local` en
local lorsqu'il existe. Ne remplacez ni le worker Clips
ni celui d’analyse Shorts. Le worker télécharge un MP4 privé (maximum 512 Mio)
dans un dossier temporaire, envoie-le en blocs résumables à YouTube, chiffre
l’URL de reprise en base et utilise un bail renouvelable pour empêcher deux
envois concurrents. Chaque publication doit passer par le récapitulatif et la
confirmation explicite dans l’interface; la visibilité par défaut est privée.

Variables serveur à configurer sans les inscrire dans Git :

```text
YOUTUBE_PUBLISH_WORKER_ENABLED=false
YOUTUBE_PUBLIC_UPLOADS_ENABLED=false
YOUTUBE_OAUTH_CLIENT_ID=…
YOUTUBE_OAUTH_CLIENT_SECRET=…
YOUTUBE_OAUTH_REDIRECT_URI=https://<app>/api/youtube/oauth/callback
YOUTUBE_OAUTH_STATE_SECRET=<secret aléatoire d'au moins 32 caractères>
YOUTUBE_TOKEN_ENCRYPTION_KEY=<base64 canonique de 32 octets aléatoires>
```

Le consentement OAuth demande `youtube.upload` et `youtube.readonly`; la
deuxième portée sert uniquement à afficher le canal lié. Google Cloud doit
autoriser exactement l’URI de callback configurée. Le worker YouTube n’est pas
provisionné en Production. Les identifiants OAuth YouTube ne sont présents ni
dans les variables Production vérifiées ni dans `.env.local`. La migration de
file `20261004150000_youtube_publication_queue.sql` est déjà appliquée sur
Supabase Production; ne pas la rejouer. Aucun envoi YouTube n’a été exécuté
pendant la validation locale.
Laisser `YOUTUBE_PUBLIC_UPLOADS_ENABLED=false` tant que le projet YouTube API
n’a pas passé l’audit de Google : les projets non vérifiés sont limités aux
vidéos privées.

## Vérifier le parcours Shorts local dans Docker

Sur Windows, les ports hôtes Supabase peuvent être réservés même quand les
conteneurs sont sains. `pnpm smoke:shorts:docker` reconstruit alors une image
temporaire depuis le worktree et exécute Next ainsi que les smokes dans le
réseau Docker Supabase. Le script lit les clés de `supabase status -o env`,
vérifie que l'URL Supabase est en loopback, ne lit pas `.env.local`, et supprime
son conteneur et son image temporaires à la fin.

Le smoke couvre l'accès authentifié au Studio, le refus quand le budget IA est
fermé, l'upload TUS et sa reprise, l'analyse audio et audio + vidéo avec
fournisseurs simulés, la sélection, deux rendus et téléchargements, le motion
design FFmpeg, la publication YouTube simulée et les 18 assertions SQL Shorts.
Il n'appelle aucun fournisseur payant ni l'API Google réelle. La commande est
locale et ne provisionne pas de service Railway.

## Exécution locale isolée des workers

`compose.workers.yaml` fournit les trois commandes one-shot dans le profil
`local-workers`; aucun port n’est exposé et chaque traitement reste désactivé
par défaut. Docker Desktop peut joindre l’API Supabase locale via
`host.docker.internal:54321` lorsque ce port hôte est disponible. Sur une
machine où Windows le réserve, définir explicitement
`CLIPSFLOW_DOCKER_SUPABASE_URL` vers un relais **local** contrôlé ; ne jamais
le remplacer par l'URL Supabase distante de `.env.local`. Cette configuration
facilite les vérifications locales mais ne provisionne aucun worker Railway.

Valider le fichier sans afficher les valeurs d’environnement :

```powershell
docker compose -f compose.workers.yaml config --quiet
```

Les secrets viennent de l’environnement du shell et ne sont pas inscrits dans
le fichier. Les protections locales restent codées en dur à `false` pour le
budget IA, l’analyse Shorts, le rendu et la publication YouTube. Ne pas activer
un worker avant d’avoir vérifié que sa file ne contient aucun travail
utilisateur non autorisé. Toute activation payante exige l’approbation
préalable du budget; la publication YouTube garde aussi son contrôle OAuth et
sa confirmation par l’utilisateur.

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
- La table privée `clips_budget_guard` est désactivée par défaut. Lorsqu'elle
  est activée avec un plafond chiffré après les mesures, `clips_submit_job`
  réserve de façon transactionnelle le coût estimé de chaque rendu. À plafond
  atteint, seuls les nouveaux rendus ClipsFlow reçoivent une indisponibilité
  temporaire : aucun projet Railway voisin n'est affecté.

## Préparation d'un environnement de test autorisé

1. Publier un commit issu de `fix/p0-security-hardening`, jamais l'ancien
   `main`, dans une branche de test revue.
2. Créer le projet Railway `clipsflow` et son unique service `clips-worker`.
   Utiliser `Dockerfile.worker`, la commande `node_modules/.bin/tsx scripts/clips-worker.ts`, aucun domaine
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
4. Mesurer le coût Railway d'un lancement vide, puis d'un rendu représentatif,
   et seulement ensuite régler puis activer `clips_budget_guard`. Le plafond
   est exprimé en USD car `clips.cost_usd` est dans cette unité ; ne pas le
   présenter comme une facture Railway ni utiliser un coupe-circuit global du
   workspace.
5. Pour la production seulement après ces preuves : vérifier l'historique des
   migrations plutôt que les rejouer (les 12 migrations Shorts autorisées sont
   déjà appliquées), activer `CLIPS_WORKER_ENABLED=true` côté worker Railway,
   déployer le garde de coupure et définir `CLIPS_WORKER_BACKEND=railway` côté
   Vercel. Après vérification du worker et du garde de coûts, définir aussi
   `CLIPS_WORKER_ENABLED=true` côté Vercel : cette variable distincte en pratique
   contrôle l'admission des demandes dans les API de rendu. Son absence ou sa
   valeur `false` garde les nouveaux rendus bloqués sans réserver de quota,
   même lorsque Railway traite correctement le cron. Le fichier `vercel.json`
   ne déclare plus de cron de traitement : Railway est l'unique dispatcher. Ne
   livrer cette suppression qu'après avoir vérifié que le worker Railway de
   production est prêt, afin d'éviter une interruption.
6. Les trois anciens services Railway sont déjà supprimés comme indiqué plus
   haut. Calpyra-AI et Cal-Halal restent hors de ce projet et ne doivent pas
   être modifiés.
