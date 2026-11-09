# Migration du studio audio — VoiceStudio d'abord

La production actuelle de Clipsflow appelle ElevenLabs pour la musique et les
effets sonores uniquement. **VoiceStudio est une autre capacité : voix, narration
et doublage.** Une bascule complète nécessite également un générateur de musique
et de SFX ; Soundbox + ACE-Step 1.5 (MIT) sont retenus pour la deuxième phase.

## Frontière privée VoiceStudio

`src/lib/clips/voicestudio.ts` expose `generateVoiceStudioNarration`.
L'adaptateur n'est **pas activé dans le pipeline de rendu** à cette étape.
Aucun appel distant ne part à l'import, aucune clé ne va au navigateur.
La requête TTS utilise `POST /v1/audio/speech` en WAV (API VoiceStudio).
Les sorties sont limitées à 16 Mio, le texte à 2 000 caractères et le délai
d'appel à 90 secondes. L'usage est bloqué sans consentement et validation des droits.

Variables privées, désactivées par défaut :

- `CLIPS_VOICESTUDIO_ENABLED=true`
- `CLIPS_VOICESTUDIO_BASE_URL=http://voicestudio:3900` (réseau Docker privé),
  ou HTTPS via proxy authentifié sur une autre machine
- `CLIPS_VOICESTUDIO_API_KEY` : Bearer secret dans le coffre de l'hébergeur
- `CLIPS_VOICESTUDIO_TTS_MODEL` : ID de moteur choisi et testé, **aucun défaut**
- `CLIPS_VOICESTUDIO_TTS_VOICE` : voix autorisée, choisie côté serveur
- `CLIPS_VOICESTUDIO_MODEL_COMMERCIAL_OK=true` après vérification des poids

## Licence et déploiement

VoiceStudio est sous AGPL-3.0 ; les modèles ont leurs licences propres.
Le modèle OmniVoice téléchargé par défaut a des poids CC-BY-NC, **ne
pas le sélectionner pour Clipsflow commercial**. Considérer le statut des
tokeniseurs et des checkpoints du moteur choisi ; ne pas supposer que la
licence du code suffit. Les modifications de VoiceStudio peuvent entraîner
des obligations AGPL envers les utilisateurs réseau.

Déployer VoiceStudio **dans un service séparé**, à accès réseau privé,
sur une machine avec GPU si nécessaire. Pas d'exposition publique de
son API d'administration. Les travailleurs Railway ne peuvent pas utiliser
`localhost` d'un PC Windows à distance. Limiter la concurrence, l'espace disque
et les téléchargements de modèles. La branche n'active ni clé ni trafic réel.

## Soundbox : musique et SFX (étape 2)

`src/lib/clips/soundbox.ts` utilise l'API asynchrone Soundbox :
`POST /api/generate` → `GET /api/jobs/{id}` → `GET /files/{id}.wav?format=mp3`.
Les durées sont bornées : 60 s pour la musique (bouclée par FFmpeg sur un
Short plus long) et trois secondes pour les effets. Aucune requête client
n'est autorisée à choisir le modèle ou l'URL.

- Musique : `audiocpp-ace-step` (ACE-Step 1.5 Turbo, MIT).
- SFX : `audiocpp-midashenglm-gen` (MiDashengLM-Gen, Apache-2.0
  selon sa fiche ; vérifier les conditions annexes des poids).
- Les deux modèles doivent être installés et préchauffés sur Soundbox.
- Le proxy HTTPS doit imposer le jeton Bearer ; Soundbox lui-même ne fournit
  pas de système de clés API pour son interface.
- Les tests sont isolés sans téléchargement ni appel GPU.

## Narration réelle dans le pipeline (étape 4)

Le profil Shorts admet maintenant un champ facultatif `voiceover` avec quatre
booléens validés côté serveur : activation, consentement, droits sur la voix,
droits commerciaux sur les poids. Les profils historiques restent valables.
Le routeur vérifie la configuration VoiceStudio avant la mise en file.
Le worker peut synthétiser **l'accroche du Short**, puis FFmpeg la superpose
à la vidéo en atténuant la piste source pendant la narration.

L'interface Shorts propose maintenant une case facultative VoiceStudio,
désactivée par défaut, et trois confirmations explicites dans les droits de
production. Le choix du moteur et de la voix est réservé au serveur.
Les champs `elevenlabs` / `elevenLabs` restent des identifiants historiques
dans les profils et capacités afin de préserver les projets enregistrés : le
code de génération actif emploie Soundbox, sans appel à ElevenLabs.

Le worker local récupère les variables VoiceStudio/Soundbox de
`compose.workers.yaml`. Après validation, appliquer la migration SQL
`20261109130000_allow_soundbox_shorts_audio.sql` avant d'activer
`CLIPS_SOUNDBOX_ENABLED`. La validation sur GPU réel et les tests de rendu
restent obligatoires avant toute mise en production.
