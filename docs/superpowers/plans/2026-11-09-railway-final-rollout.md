# Clipsflow Railway — plan de finalisation et état d’application

> Exécution : suivre les étapes dans l’ordre. Une case cochée nécessite une preuve. Un démarrage réussi ne prouve ni une génération IA ni un parcours utilisateur complet.

**Objectif :** héberger le web, les API et les workers sur Railway, remplacer ElevenLabs par VoiceStudio et Soundbox, sans interrompre la production.

**Architecture :** conserver les services Railway existants et Supabase pour Auth, PostgreSQL et Storage. VoiceStudio et Soundbox restent des services privés distincts. Aucun GPU externe ni nouvel hébergement Vercel.

**Stack :** Next.js, TypeScript, FFmpeg, Railway, Supabase, VoiceStudio, Soundbox.

**Spécification :** `docs/RAILWAY_FULL_DEPLOYMENT.md`, `docs/OPEN_AUDIO_MIGRATION.md`.

## Contraintes et critères de décision

- Ne pas modifier les données réelles, les projets voisins, la facturation globale ou les clés Stripe live.
- Supabase MCP reste en lecture seule ; aucune tentative de contourner un refus d’accès.
- Secrets conservés dans Railway ; ne jamais les placer dans Git, les journaux ou GitHub Actions.
- Gratuité du logiciel ne signifie pas gratuité de la capacité Railway. Ne pas accepter le déploiement audio lourd avant accord sur son coût.
- Poids OmniVoice CC-BY-NC exclus de l’usage commercial. Vérifier aussi les conversions, tokeniseurs et voix des modèles retenus.
- Un seul ensemble de workers doit consommer les travaux utilisateurs ; les canaries restent inactives ou en vérification.
- Préserver les déploiements de production existants jusqu’à la validation des modèles, de la migration et des parcours authentifiés.

## 1. Révision et services de recette — terminé

- [x] Vérifier dans GitHub Actions le commit `33b2a476fe2d0db5361b6ed7a620a0abd31b6689` : run `42635268010`, job `129221657004`, conclusion `success`.
- [x] Vérifier les étapes réelles : tests d’audit, migration sur PostgreSQL éphémère, suite avec FFmpeg, TypeScript, ESLint et build.
- [x] Aligner les quatre canaries sur cette même révision. Le worker YouTube, resté sur `02e5cf2`, a été corrigé pendant cette intervention.
- [x] Confirmer les quatre déploiements `SUCCESS` et le web en ligne.
- [x] Confirmer les modes sûrs dans les logs : rendu et YouTube `worker_disabled`, analyse `worker_verify_only_complete`.

Les canaries restent épinglées sur ce code déjà validé. Les mises à jour documentaires et les gardes de lancement audio ne doivent pas changer implicitement leur version.

## 2. Configuration et cible Supabase — audit terminé, accès bloqué

- [x] Exécuter et lire le contrôle de pré-déploiement sans valeur de secret sur les quatre services.
- [x] Confirmer l’origine Railway du web et l’absence d’activation de génération audio.
- [x] Identifier la base effective : `ifwdzqzoqwitahffrvcr`, depuis la configuration Railway auditée.
- [x] Tester l’accès au bon projet avec le connecteur Supabase : accès refusé.
- [ ] Reconnecter Supabase au compte/à l’organisation donnant accès à ce projet.
- [ ] Lire les contraintes réelles, migrations, règles d’accès et callbacks du projet autorisé.

**Blocage exact :** le connecteur ne liste que `tubeforge` (`pngkujqyrdmrunxksjjb`). Ce n’est pas la référence utilisée par Clipsflow ; aucune migration n’y a été tentée.

## 3. Services audio privés — préparation faite, exécution en attente

- [x] Inventorier la préparation déjà présente en environnement Railway `staging` ; ne pas créer de doublons.
- [x] Retenir les versions publiées VoiceStudio `0.5.7` et Soundbox `v0.4.1` ; aucune étiquette flottante `latest`.
- [x] Conserver les limites déjà prévues : 2 vCPU et 8 Go RAM maximum par service, un volume de 5 000 Mo chacun, aucun domaine public.
- [x] Ajouter des commandes de démarrage qui refusent l’exécution tant que `CLIPS_AUDIO_ROLLOUT_APPROVED` n’est pas exactement `true`.
- [x] VoiceStudio : exiger une clé de service d’au moins 32 caractères avant démarrage, sans jamais l’afficher.
- [x] Soundbox : bloquer le démarrage tant que la protection de l’accès privé n’a pas été explicitement validée. Ce drapeau n’implémente pas lui-même une authentification.
- [x] Tester les commandes shell : 9 tests, initialement en échec, puis tous réussis. Les exécutables des fournisseurs sont simulés ; ce n’est pas une preuve d’inférence.
- [x] Appliquer ces gardes aux changements Railway en attente, avec les autorisations sur `false` et les téléchargements Hugging Face hors ligne.
- [ ] Confirmer la disponibilité et les empreintes des images dans le registre ; un tag de version n’est pas une empreinte immuable.
- [ ] Définir un budget autorisé CPU/RAM/disque, créer la clé privée VoiceStudio et installer la protection d’accès de Soundbox.
- [ ] Revoir le patch Railway complet puis seulement accepter son déploiement.
- [ ] Installer un moteur vocal CPU/français compatible VoiceStudio et vérifier chaque artefact exact. Kokoro est un candidat à évaluer, pas un moteur déjà validé ici.
- [ ] Installer les checkpoints ACE-Step et MiDashengLM-Gen autorisés. Vérifier leur taille avant de prétendre que les volumes de 5 Go suffisent.
- [ ] Générer une narration française, une musique instrumentale et un SFX ; mesurer silence, durée, taille, RAM et temps CPU.

**État réel :** deux configurations audio et deux volumes sont en attente, sans déploiement actif ni modèle exécuté. Le patch n’a pas été accepté. Aucun plafond de ressources n’a été augmenté pendant cette intervention.

## 4. Migration de données — test isolé réussi, production non modifiée

- [x] Vérifier le test de la migration réelle `20261109130000_allow_soundbox_shorts_audio.sql` sur PostgreSQL jetable dans la CI réussie.
- [ ] Sur le projet autorisé, relever la contrainte `shorts_audio_assets.provider`, l’historique et une sauvegarde utilisable.
- [ ] Appliquer la migration ciblée via un canal d’écriture explicitement autorisé, sans transformer le connecteur read-only en accès d’écriture.
- [ ] Vérifier `soundbox` accepté, fournisseurs inconnus rejetés, anciennes lignes conservées, RLS et privilèges inchangés.

## 5. Recette fonctionnelle — partiellement validée

- [x] Vérification HTTP antérieure consignée dans la PR #58 : santé, pages FR/EN, login et refus des routes privées pour un visiteur anonyme.
- [x] Rendu FFmpeg sur pistes synthétiques validé par la CI ; il ne remplace pas une génération de modèle audio.
- [ ] Faire un parcours authentifié avec compte et médias de recette : import, analyse, choix, narration/musique/SFX, rendu et téléchargement.
- [ ] Vérifier connexion Supabase, retour de paiement Stripe en mode test et callbacks Google/YouTube sur le domaine Railway définitif.
- [ ] Configurer les secrets OAuth/YouTube manquants sur les services concernés. Aucune publication réelle sans confirmation utilisateur spécifique.

## 6. Bascule définitive — volontairement non exécutée

- [ ] Fusionner la pile de PR après revue des preuves et des dépendances ; ne pas confondre code préparé et production active.
- [ ] Déployer un SHA unique validé sur le web et les workers de production.
- [ ] Basculer les consommateurs un par un et vérifier l’absence de double traitement.
- [ ] Valider le trafic et les webhooks, puis retirer les services canary inutiles.
- [ ] Désactiver l’ancien hébergement Vercel seulement après validation du parcours complet ; conserver un retour arrière explicite.

## Retour arrière

Conserver les déploiements de production actuels. Un rollback applicatif ne doit ni effacer les fichiers audio ni supprimer les lignes `soundbox`. Ne pas rétrécir la contrainte SQL si ces lignes existent. En cas d’échec de recette, garder les fournisseurs audio désactivés.

## Preuves et état

Voir `docs/reports/2026-11-09-railway-rollout-status.md`. Les cases ouvertes sont des actions non réalisées ou non prouvées, pas des travaux en cours en arrière-plan.
