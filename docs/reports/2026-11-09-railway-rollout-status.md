# Clipsflow — compte rendu d’exécution Railway

Date : 9 novembre 2026. Cible : projet Railway `clipsflow` uniquement.

## Résultat

Le code applicatif déjà validé est aligné sur les quatre services de recette Railway. Le worker YouTube était resté sur une ancienne révision : sa source a été corrigée et son nouveau déploiement a été confirmé réussi. La production existante est inchangée. Les services audio sont préparés, pas démarrés ; la migration de la base réelle est bloquée par un refus d’accès.

## Révision et déploiements vérifiés

SHA applicatif : `33b2a476fe2d0db5361b6ed7a620a0abd31b6689`.

| Service | Déploiement vérifié | Résultat |
|---|---|---|
| clipsflow-web-railway-canary | fba8e44d-4bbe-4e46-95fa-7ef86f84c48a | SUCCESS ; web en ligne |
| clipsflow-render-canary | da1351dc-7c5f-4ce5-8936-4e51d1027cde | SUCCESS ; worker_disabled |
| clipsflow-shorts-analysis-canary | a7bbc4dd-6c26-4a3a-84c4-8e2dcce03334 | SUCCESS ; worker_verify_only_complete |
| clipsflow-youtube-canary | 2d031ea5-ed43-4b4c-8bfd-634dd42fb37f | SUCCESS ; worker_disabled |

Le contrôle Railway des sept services de l’environnement production ne rapporte aucun service en erreur au moment de la vérification. Le succès d’un cron inactif n’est pas une preuve de traitement vidéo ou de publication.

## Tests et preuves

- CI existante vérifiée : run `42635268010`, job `129221657004`, conclusion `success`. Étapes réussies : tests d’audit, migration sur PostgreSQL jetable, suite avec FFmpeg réel, TypeScript, ESLint et build sans secrets de production.
- Nouveaux tests exécutés pendant cette intervention : `node --test scripts/railway-audio-launch.test.mjs`, 9 échecs avant ajout de la configuration puis 9 réussites.
- Ces nouveaux tests exécutent les gardes shell réelles, avec des exécutables de fournisseur simulés. Ils ne téléchargent et ne lancent aucun modèle IA.
- Le conteneur de travail ne résout pas les domaines externes ; la validation complète du dépôt s’appuie sur la CI GitHub consultée, pas sur une compilation locale revendiquée.

## Configuration audio en attente

Environnement : staging (`3b7161b7-f10c-4833-b008-e52ff1bfe169`). Patch : `ff232506-04f4-412a-828d-e4247cbee488`.

| Élément | VoiceStudio | Soundbox |
|---|---|---|
| Service | clipsflow-voicestudio | clipsflow-soundbox |
| Version prévue | ghcr.io/debpalash/voicestudio:0.5.7 | ghcr.io/hamsanders/soundbox:v0.4.1 |
| Limites préexistantes | 2 vCPU / 8 Go | 2 vCPU / 8 Go |
| Volume en attente | 5 000 Mo | 5 000 Mo |
| Domaine public | aucun | aucun |
| Déploiement effectif | aucun | aucun |

Changements appliqués au patch : gardes de démarrage, CPU explicite pour VoiceStudio, hôtes privés autorisés, mode Hugging Face hors ligne et autorisations restant à `false`. Les ressources n’ont pas été augmentées. Le patch n’a pas été accepté.

Le garde Soundbox exige une confirmation de protection d’accès ; il n’ajoute pas une API key au serveur Soundbox. Une passerelle authentifiée ou une politique réseau appropriée reste à configurer avant activation. La présence d’un tag de version ne prouve ni son digest ni la compatibilité effective de l’image.

## Blocages confirmés

1. **Supabase** : les audits Railway désignent `ifwdzqzoqwitahffrvcr`. Le connecteur ne liste que `tubeforge` (`pngkujqyrdmrunxksjjb`) et refuse l’accès à la référence Clipsflow. Aucune écriture ni migration de la mauvaise base.
2. **Capacité audio et authentification** : accord de coût, clé VoiceStudio et protection Soundbox à finaliser avant démarrage. Aucun calcul GPU externe provisionné.
3. **Modèles** : les checkpoints précis, leur stockage et leurs performances CPU ne sont pas encore validés. Aucune voix, musique ou SFX IA réellement généré pendant cette intervention.
4. **Parcours complet** : callbacks et secrets Google/YouTube absents de la recette observée ; flux authentifié complet et retour Stripe test non prouvés.

## Sources techniques utilisées

- GitHub Actions : https://github.com/Billel-ABBAS/clipsflow/actions/runs/42635268010
- Corrections et vérifications antérieures : https://github.com/Billel-ABBAS/clipsflow/pull/58
- Plan existant : https://github.com/Billel-ABBAS/clipsflow/pull/59
- Commandes Railway : https://docs.railway.com/deployments/start-command
- VoiceStudio : https://github.com/debpalash/VoiceStudio/releases/tag/v0.5.7
- Soundbox : https://github.com/HamSanders/soundbox/releases/tag/v0.4.1

Les limites CPU/RAM sont des plafonds, pas une facture. Les modèles gratuits ne rendent pas le calcul Railway gratuit. Le coût réel nécessite une mesure et une limite de budget approuvée.
