# Protocole Smoke Test — Phase 1 PolyCast Clips

**Exécuté par : le fondateur** (pas par un agent CI — nécessite un vrai fichier audio, un compte Supabase live et un serveur Next.js local).

---

## Prérequis

### Variables d'environnement (`.env.local`)

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GROQ_API_KEY=gsk_...
CRON_SECRET=un-secret-quelconque
```

### Migrations appliquées

```bash
npx supabase db push --linked
# ou manuellement :
npx supabase db query --linked --file supabase/migrations/0001_init.sql
npx supabase db query --linked --file supabase/migrations/0002_clips_schema.sql
```

### Démarrer le serveur dev

```bash
pnpm dev
# → http://localhost:3000
```

---

## Étapes

### Étape 1 — Créer un compte

| Action                                 | Attendu                    | PASS/FAIL |
| -------------------------------------- | -------------------------- | --------- |
| Ouvrir `http://localhost:3000/login`   | Page de login affichée     |           |
| Créer un compte (email + mot de passe) | Redirect vers le dashboard |           |

**Critère PASS :** utilisateur authentifié, profil visible dans Supabase `profiles`.

---

### Étape 2 — Upload d'un fichier audio

| Action                                         | Attendu                                         | PASS/FAIL |
| ---------------------------------------------- | ----------------------------------------------- | --------- |
| Depuis le dashboard, ouvrir la page clips      | Section "Nouveau clip" visible                  |           |
| Uploader un fichier MP3 ou M4A de 5-10 minutes | Barre de progression, pas d'erreur 400/422      |           |
| Attendre la confirmation d'upload              | Message de succès ou épisode créé dans la liste |           |

**Critère PASS :** l'épisode est visible dans la table `episodes` avec un `audio_storage_path` non null.

---

### Étape 3 — Créer un clip depuis le Studio

| Action                                                      | Attendu                                    | PASS/FAIL |
| ----------------------------------------------------------- | ------------------------------------------ | --------- |
| Ouvrir le Studio clips                                      | Formulaire en 4 étapes visible             |           |
| Étape 1 : sélectionner l'épisode uploadé                    | Épisode listé                              |           |
| Étape 2 : saisir un segment 30–60 s (ex: `00:30` → `01:00`) | Champs acceptés, pas de validation error   |           |
| Étape 3 : choisir style "Viral", aspect ratio 9:16          | Preset chargé                              |           |
| Étape 4 : soumettre                                         | Status du clip = `pending` dans la galerie |           |

**Critère PASS :** une row `clips` en status `pending` ET une row `jobs` en status `pending` dans Supabase.

---

### Étape 4 — Déclencher le cron manuellement

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/process-clips
# Attendu : 200
```

| Action                                             | Attendu                   | PASS/FAIL |
| -------------------------------------------------- | ------------------------- | --------- |
| Exécuter la commande curl ci-dessus                | HTTP 200                  |           |
| Attendre 30–90 secondes (traitement Groq + ffmpeg) | —                         |           |
| Rafraîchir la galerie                              | Clip status = `completed` |           |

**En cas d'échec :** vérifier les logs Next.js dans le terminal — le message d'erreur contient le préfixe d'erreur (ex: `whisper_failed: ...`, `subtitle_burn_failed: ...`).

---

### Étape 5 — Vérifier le résultat dans la galerie

| Vérification             | Attendu                                                    | PASS/FAIL |
| ------------------------ | ---------------------------------------------------------- | --------- |
| Status badge             | `completed` (vert)                                         |           |
| Lecture du MP4           | Vidéo se lance, sous-titres visibles                       |           |
| Bouton "Télécharger VTT" | Fichier `.vtt` téléchargé, format correct (WEBVTT en-tête) |           |
| Score hook               | Badge coloré affiché (0–100)                               |           |
| Coût                     | `cost_usd` non null dans la table `clips`                  |           |

---

## Variantes à tester

### Variante A — Source URL (au lieu d'un upload)

- Dans le Studio, choisir "URL" comme source.
- Entrer une URL HTTPS vers un fichier MP3 ou MP4 accessible publiquement (ex: fichier de test hébergé sur GitHub Releases).
- Soumettre et déclencher le cron.
- **Critère PASS :** même résultat qu'avec l'upload direct.

### Variante B — Épisode existant (idempotence storage)

- Créer un second clip sur le même épisode, avec les mêmes paramètres (même segment, même style).
- Déclencher le cron.
- **Critère PASS :** un nouveau fichier MP4 est stocké avec un path différent (UUID distinct), pas d'écrasement du premier.

### Variante C — Clip > 180 s refusé

- Dans le Studio, entrer un segment de plus de 3 minutes (ex: `00:00` → `04:00`).
- **Critère PASS :** le formulaire affiche une erreur de validation "Durée maximum 3 minutes" et ne soumet pas.
- **Ou :** si la validation est server-side, la route `/api/clips/jobs` retourne HTTP 422 avec un message explicite.

### Variante D — Second clip avec mêmes paramètres (idempotence)

- Créer un second clip identique au premier (même épisode, même segment, même style).
- Déclencher le cron.
- **Critère PASS :** deux rows distinctes dans `clips` (pas d'upsert qui écraserait la première), chacune avec son propre `video_storage_path`.

---

## Critères FAIL globaux

- HTTP 500 sur n'importe quelle route durant le flow normal.
- Clip bloqué en status `processing` > 5 minutes sans passer à `completed` ou `failed`.
- Fichier MP4 absent ou corrompu (non lisible par le navigateur).
- Fichier VTT absent ou avec un format invalide (pas de `WEBVTT` en première ligne).
- Score hook absent (`null`) sur un clip `completed` qui a du texte transcrit.
