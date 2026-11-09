# Clipsflow Railway — plan de finalisation

> Pour l'exécution : suivre les tâches ci-dessous dans l'ordre et joindre une preuve à chaque case cochée. Un service qui démarre n'est pas une preuve de génération IA.

**Objectif :** héberger le web, les API et tous les workers sur Railway, remplacer ElevenLabs par VoiceStudio et Soundbox, sans interruption de production ni appel IA payant implicite.

**Architecture :** Next.js et les workers restent séparés dans le projet Railway `clipsflow`. VoiceStudio et Soundbox seront des services privés ; Supabase conserve Auth, PostgreSQL et Storage. Une seule chaîne de production consomme les jobs ; les canaries ne doivent pas traiter les données des utilisateurs.

**Stack :** Next.js, TypeScript, FFmpeg, Railway, Supabase, VoiceStudio, Soundbox.

**Spécification :** `docs/RAILWAY_FULL_DEPLOYMENT.md`, `docs/OPEN_AUDIO_MIGRATION.md` et demande explicite de l'utilisateur : Railway, pas Vercel, VoiceStudio prioritaire.

## Contraintes globales

- Ne pas modifier les projets Railway voisins, les données réelles, les clés Stripe live ou les réglages globaux de facturation.
- Garder les appels IA payants désactivés pendant la recette. Aucun GPU externe à provisionner.
- Supabase MCP reste en lecture seule conformément à `CLAUDE.md` ; identifier le bon projet avant toute inspection ciblée.
- Ne jamais publier une valeur de secret. Utiliser les références Railway pour les secrets existants ; ne pas les faire transiter par GitHub Actions.
- Les images et les checkpoints audio doivent être épinglés. La licence de VoiceStudio ne remplace pas celle des poids.
- Ne pas sélectionner les poids OmniVoice CC-BY-NC pour le service commercial.
- Le CPU/RAM/disque Railway est facturable : gratuité du logiciel != hébergement gratuit. Ne pas augmenter silencieusement le budget pour de gros modèles.
- Aucun merge global ni bascule production sans les preuves CI, SQL, modèles et parcours ci-dessous.

## Points de revue

1. Même révision applicative sur le web et les trois workers, sans deux consommateurs actifs.
2. Narration effectivement transmise au worker ; option désactivée réellement sans effet.
3. Secrets non journalisés ; téléchargements sans redirection vers une destination inattendue.
4. Compatibilité de la contrainte SQL `shorts_audio_assets.provider`, RLS et données historiques.
5. Tests audio réels : voix française, musique instrumentale, SFX, durée, silence, charge CPU et délai maximum.

## État de départ constaté

- PR #53–#57 : intégration audio empilée, non fusionnée dans `main`.
- PR #58 : corrections supplémentaires et CI. HEAD `02e5cf26c74e4f455d9f1dd5a90a5fe5956d0fa3` ; code applicatif précédemment testé `0d0eec48f0b0afea6144627de55dc3dd51d7cd56`.
- Web et rendu canary : branche `fix/railway-deployment-20261109`.
- Analyse et YouTube canary : encore sur `feat/voicestudio-shorts-ui-20261109` au début de cette intervention.
- Aucun service VoiceStudio/Soundbox ni volume audio recensé dans Railway.
- Le connecteur Supabase ne liste qu'un projet nommé `tubeforge`. Ne pas supposer qu'il correspond à Clipsflow.

## Tâche 1 — Verrouiller et aligner la version de recette

- [x] Lire l'inventaire Railway et la PR #58 ; conserver les services de production existants.
- [ ] Vérifier les résultats GitHub Actions du commit retenu, pas seulement le texte de la PR.
- [ ] Épingler les quatre canaries sur la même révision validée.
- [ ] Confirmer `SUCCESS` et les modes inactifs/vérification dans les journaux.

**Preuve :** SHA, IDs des déploiements et résultats CI consignés dans le compte rendu.

## Tâche 2 — Vérifier la configuration sans exposer les secrets

**Fichiers :** `scripts/railway-rollout-preflight.mjs`, son test Node et la CI de validation.

- [ ] Écrire puis exécuter les tests : clés masquées, service manquant, flag activé par erreur, URL Railway attendue.
- [ ] Implémenter un audit en lecture seule : noms/présence des variables, référence publique du projet Supabase, URLs et flags non sensibles.
- [ ] Exécuter le contrôle dans un worker canary, sans traitement vidéo, téléchargement de modèle ou écriture SQL.
- [ ] Identifier le projet Supabase effectif et relever les prérequis OAuth/Stripe manquants sans lire les valeurs des clés.

**Preuve :** rapport JSON ne contenant aucun secret ; aucun travail utilisateur acquis.

## Tâche 3 — Préparer puis valider les services audio privés

- [ ] Choisir une image VoiceStudio publiée et une image Soundbox publiée, avec version/digest explicites.
- [ ] Préparer sur Railway des services privés, limites CPU/RAM, volumes persistants et aucune URL publique.
- [ ] Empêcher l'installation implicite du modèle OmniVoice non commercial et toute activation du fournisseur sans modèle validé.
- [ ] Raccorder les services via DNS privé et authentification dédiée ; ne pas réutiliser une clé de production sans nécessité.
- [ ] Installer un moteur vocal compatible CPU/français et un checkpoint à licence vérifiée ; enregistrer la référence exacte.
- [ ] Installer ACE-Step pour la musique et MiDashengLM-Gen pour les SFX après vérification des poids et du budget CPU/disque.
- [ ] Exécuter trois générations synthétiques de test et mesurer durée, taille, absence de silence, mémoire et temps réel.

**Point d'arrêt :** si les modèles ne tiennent pas dans la capacité/budget approuvés, conserver les ressources en attente et les flags désactivés. Ne jamais présenter une simple API saine comme une inférence validée.

## Tâche 4 — Valider la base et la compatibilité

**Migration existante :** `supabase/migrations/20261109130000_allow_soundbox_shorts_audio.sql`.

- [ ] Exécuter un test SQL local/CI sur base éphémère : Soundbox accepté, fournisseur inconnu refusé, anciennes lignes conservées, RLS et privilèges inchangés.
- [ ] Inspecter en lecture seule la contrainte réelle sur le projet Clipsflow confirmé.
- [ ] Préparer la commande de migration ciblée et la preuve de sauvegarde/retour arrière.
- [ ] Appliquer la migration seulement par le canal d'écriture autorisé puis revérifier.

**Point d'arrêt :** pas d'écriture via un accès déclaré read-only ; pas de migration d'un projet au nom voisin.

## Tâche 5 — Recette et mise en production

- [ ] CI : tests complets, TypeScript, lint et build, sans secrets de production.
- [ ] HTTP : santé, pages FR/EN, login, protection des routes privées et absence de dépendance runtime Vercel.
- [ ] Parcours authentifié sur fixtures : import, analyse, sélection, rendu audio, téléchargement ; aucun paiement ni publication réelle.
- [ ] Vérifier callbacks Supabase, Stripe et Google/YouTube pour le domaine Railway retenu.
- [ ] Fusionner les changements validés dans l'ordre de dépendance et épingler une révision de production.
- [ ] Basculer les consommateurs un par un ; désactiver les canaries ; vérifier l'absence de double traitement.
- [ ] Fermer l'ancien hébergement Vercel seulement après validation du trafic et des callbacks ; conserver un retour arrière explicite.

## Retour arrière

Conserver les IDs des déploiements de production avant toute modification. En cas d'échec de recette, laisser les fournisseurs audio désactivés et maintenir la production actuelle. Ne pas effacer les fichiers audio historiques ni réduire la contrainte SQL tant que des lignes `soundbox` existent. Un rollback de code ne doit pas supprimer de données.

## Journal d'exécution

Les résultats de cette intervention sont consignés dans `docs/reports/2026-11-09-railway-rollout-status.md`. Les cases non cochées sont des actions non prouvées, pas des travaux exécutés en arrière-plan.
