# Soundbox — accès privé réellement authentifié

Remplace le simple drapeau de confirmation par une passerelle Node dans le même
conteneur que Soundbox. Le moteur brut écoute uniquement sur 127.0.0.1:17494 ;
la passerelle écoute sur :: et PORT=8080. Ne créer aucun domaine public.

Variables serveur : CLIPS_AUDIO_ROLLOUT_APPROVED=true après accord de coût,
CLIPS_SOUNDBOX_PROXY_TOKEN secret aléatoire 32–128 caractères base64url/hex.
Ne pas utiliser les clés Supabase ou Stripe comme clé de passerelle.
Côté Clipsflow, utiliser le même secret et BASE_URL sur le DNS Railway privé,
port 8080. Le client Soundbox existant ajoute déjà Authorization: Bearer.

Routes permises : POST /api/generate, GET /api/jobs/{uuid}, GET /api/health,
GET /files/{uuid}.wav?format=mp3. Administration et MCP sont refusés.
Les secrets et cookies entrants ne sont pas transmis au moteur brut.
Les modèles, durées, taille des messages, réponses et concurrence HTTP sont bornés.
/healthz teste l'API amont sans déclarer une inférence réussie.

Tests locaux : 11 échecs avant implémentation puis 13 réussites après ajout des
cas de santé et MIME. Ils utilisent de vrais serveurs HTTP en boucle locale,
pas un modèle IA. Le Dockerfile/registre est vérifié séparément par la CI.

Aucun déploiement audio facturable n'est activé par ce code. Les modèles,
leurs licences, leur stockage et leurs performances CPU restent à vérifier.
Ce composant fournit l'authentification, pas une autorisation de budget.
