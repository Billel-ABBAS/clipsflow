# Recette Production contrôlée — Studio Shorts

Ce runbook décrit le premier test réel, synthétique et authentifié du parcours
**analyse** de Studio Shorts. Il ne vaut pas autorisation de l'exécuter. Il est
intentionnellement distinct de la recette de rendu, de musique et de publication
YouTube.

## But et périmètre

Prouver sur Production que le chemin suivant fonctionne avec un seul projet de
démonstration identifié et un seul média synthétique :

```text
session authentifiée → import privé reprenable → finalisation de la source
→ mise en file de l'analyse → transcription et propositions d'extraits
→ consultation authentifiée des résultats → nettoyage vérifié
```

Le test doit couvrir exactement un des modes `audio` ou `audio + vidéo`, indiqué
dans l'autorisation. Le second mode est une recette distincte. Les candidats
proposés ne doivent pas être publiés, rendus, téléchargés ni envoyés à YouTube.

## Interdictions absolues

- ne pas changer, afficher, exporter ni faire tourner une clé existante ;
- ne pas appliquer de migration ni modifier les quotas ;
- ne pas ouvrir Remotion, ElevenLabs, les SFX, l'analyse Opus approfondie,
  Jev, le rendu, le ZIP ou YouTube ;
- ne pas utiliser de média, compte, projet, chaîne ou données d'un utilisateur ;
- ne pas réessayer automatiquement un appel fournisseur ou un upload après une
  erreur ;
- ne pas laisser le gate web ouvert après la recette, réussie ou non.

## Préconditions à lire juste avant l'exécution

1. Noter le commit Production Vercel, le déploiement Railway du worker et
   l'heure de départ de la recette.
2. Vérifier que `shorts-analysis-worker-production` est déployé, en mode
   `process-one`, planifié, et que `shorts_is_analysis_worker_healthy()` vaut
   `true`.
3. Vérifier par une requête agrégée qu'aucun job `pending` ou `processing`
   préexistant ne se trouve dans `shorts_analysis_jobs`. Sinon, arrêter : la
   file ne peut pas être confondue avec le test.
4. Vérifier que le gate Vercel
   `SHORTS_ANALYSIS_WORKER_READY` est fermé avant la fenêtre de test.
5. Vérifier la disponibilité serveur du fournisseur prévu et la présence de
   son budget explicitement autorisé, sans lire ni imprimer de secret. Si le
   fournisseur n'est pas prêt, arrêter avant upload.
6. Enregistrer une autorisation humaine explicite qui nomme : le passage
   `audio` ou `audio + vidéo`, un seul média synthétique, le fournisseur réel,
   une limite d'un job, le nettoyage et la fermeture du gate.

## Fixture et identité de test

- Générer localement une source non personnelle et reconnaissable comme test :
  mire graphique et tonalité simple, avec une courte piste parlée synthétique
  seulement si la transcription doit produire du texte significatif.
- La durée doit rester dans la borne produit ; pour le premier test, viser
  60–90 secondes afin de limiter les coûts et le temps de récupération.
- Créer un compte et un projet dédiés avec une adresse `@example.invalid` et un
  préfixe unique de session, par exemple `prod-shorts-smoke-<uuid>`.
- Capturer uniquement l'identifiant opaque du compte, du projet, de l'épisode,
  du job et du chemin Storage dans un journal local temporaire exclu de Git.
  Ne jamais y écrire de token, de cookie ou de clé.

## Séquence autorisée

1. Passer **seulement** `SHORTS_ANALYSIS_WORKER_READY=true` dans Vercel
   Production, noter le déploiement qui applique la variable, puis vérifier que
   le Studio authentifié accepte l'analyse. Ne pas changer les autres variables.
2. Créer la session du compte synthétique et vérifier que les routes anonymes
   refusent encore les accès aux ressources privées.
3. Initialiser l'upload, envoyer la fixture avec TUS, interrompre une seule fois
   un petit upload uniquement si la recette inclut la reprise, puis finaliser la
   source. Vérifier propriété, type, taille et durée côté serveur.
4. Soumettre exactement une analyse avec le mode autorisé et des consignes
   déterministes. Consigner l'estimation et l'identité du fournisseur avant
   soumission ; aucune seconde soumission ne doit être faite.
5. Observer le job par son identifiant : passage en attente, réclamation unique,
   progression, puis succès ou erreur explicite. Vérifier que le worker ne prend
   pas un job qui ne porte pas le préfixe de session.
6. En cas de succès, vérifier via la session authentifiée : transcription
   horodatée non vide, candidats reliés à des bornes valides de la source,
   sélection modifiable, et indisponibilité inchangée des actions de rendu,
   musique et YouTube non incluses dans la recette.
7. Ne sélectionner un candidat que si l'autorisation le prévoit ; ne soumettre
   aucun rendu. En cas d'erreur fournisseur, conserver le code, l'étape et le
   message redacted, puis arrêter sans retry automatique.

## Critères de réussite

- un seul job portant le préfixe de session est créé et réclamé une seule fois ;
- le provider réel est appelé au plus une fois par étape prévue ;
- le transcript et les candidats sont attachés au projet synthétique, avec
  horodatages et bornes cohérents ;
- aucun autre compte ou projet n'est visible ou modifié ;
- le worker garde un heartbeat frais et aucun job reste `pending` ou
  `processing` à la clôture ;
- aucune option hors périmètre n'est activée ;
- toutes les preuves sont classées comme Production + fournisseur réel, jamais
  comme validation de rendu, de musique ou de YouTube.

## Nettoyage obligatoire, même après échec

1. Remettre immédiatement `SHORTS_ANALYSIS_WORKER_READY=false` dans Vercel et
   vérifier le déploiement correspondant.
2. Annuler ou marquer terminal tout job synthétique encore actif selon le
   mécanisme applicatif ; ne jamais supprimer une ligne d'un autre utilisateur.
3. Supprimer dans l'ordre les artefacts dérivés du projet synthétique, la source
   privée Storage, les lignes de projet/épisode autorisées par les contraintes,
   puis le compte synthétique. Conserver seulement les traces opérationnelles
   minimales requises par la politique de rétention.
4. Revérifier `0` compte, projet, épisode, chemin Storage et job portant le
   préfixe de session, ainsi que `0` job actif global dans la file.
5. Capturer les états finals du gate, du worker et des compteurs de file ;
   ajouter une entrée redacted dans `docs/ROADMAP.md` avec les résultats, les
   coûts observés et les limites restantes.

## Retour arrière

Le retrait du gate Vercel ferme immédiatement l'admission de nouvelles analyses.
Si le worker ou le fournisseur échoue, ne pas changer son moteur ni appliquer de
fallback silencieux. Garder le worker actif sur file vide pour publier son
heartbeat, documenter l'échec et réparer dans un lot séparé avant une nouvelle
recette explicitement autorisée.
