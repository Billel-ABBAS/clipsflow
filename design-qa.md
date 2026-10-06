# Design QA — fidélité Canva du Studio Shorts

Date : 6 octobre 2026. Périmètre : interface réelle de /fr/shorts, état d’import et espace de sélection. Ce contrôle visuel ne vaut pas validation des fournisseurs payants ou de la publication YouTube réelle.

## Référence et méthode

- Direction approuvée : [maquette Canva](https://www.canva.com/design/DAHXLRHjrcI/gjPFdgOGw8LLxZkSJOrOIA/edit).
- Capture fournie : C:/Users/adama/AppData/Local/Temp/codex-clipboard-47edb0c3-4741-4bd2-8938-549ecbc61fb6.png, **1487 × 1058 px**.
- Comparaison à état et dimensions identiques : maquette « sélection », capture du vrai composant React avec jeu de données de démonstration dans /fr/shorts-preview.
- Cette route est désormais publiable en production à la demande explicite de l’utilisateur. Elle reste une démonstration en lecture seule : les handlers ne lancent ni import distant, ni analyse, ni rendu ; cliquer sur le rendu affiche un avis explicite. Le mode est signalé dans l’en-tête et sur les petits écrans. La route ne doit pas être indexée par les moteurs de recherche.
- L’inspection du fichier Canva a été annulée sans enregistrer de changement. Aucun portrait n’a été généré.
- Les recadrages de la capture originale servent uniquement à la démonstration et à la vérification de design. La route authentifiée ne reçoit pas ces médias de démonstration. Le logo reprend le signe fourni dans la direction approuvée.

## Modifications vérifiées

- Palette bleu nuit, violet, corail et menthe transposée en variables sémantiques ; gradients, contours, rayons et états de focus cohérents.
- Logo, barre produit et projet, rail des cinq étapes, proportions des trois colonnes, titre, cartes et inspecteur vertical rapprochés de la référence.
- Zone centrale étendue : suppression de la limite de 980 px qui produisait un grand espace perdu sur les écrans larges.
- Carte active bordée de corail ; titres et explications lisibles, sélection distincte de l’ouverture d’un extrait.
- Transcription et timeline réellement commutables, recherche insensible aux accents, état sans résultat explicite et accès aux 24 extraits.
- Motion activable/désactivable, mouvement réduit prioritaire ; réglages avancés placés sous les actions principales.
- Action d’analyse persistante dans le formulaire, sans masquer l’accès aux champs lors du défilement.
- Typographie globale corrigée : les variables de police ne se référencent plus elles-mêmes.

## Contrôles navigateur

| Dimensions  | État                                                                     | Résultat                                                                                                                  |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1487 × 1058 | Sélection, comme Canva                                                   | Trois colonnes, cartes, transcription et aperçu vérifiés côte à côte.                                                     |
| 1908 × 947  | Import, comme le site de la capture utilisateur hors barre du navigateur | Largeur utilisée, aperçu vide explicatif, bouton d’analyse visible dans la fenêtre.                                       |
| 1150 × 850  | Sélection                                                                | Trois panneaux adaptés sans débordement horizontal global.                                                                |
| 1024 × 768  | Sélection                                                                | Inspecteur sous le travail central, sans chevauchement ; miniature de source non écrasée.                                 |
| 390 × 844   | Import et sélection                                                      | Barre compacte, étapes et cartes défilables, champs sur une colonne, réglages accessibles ; largeur du document = 390 px. |

Interactions contrôlées : ouverture d’un autre extrait et changement de l’aperçu/du timecode ; filtre de sélection ; ambiance légère ; recherche « communaute » sans accent ; recherche sans résultat ; pagination jusqu’à la page 8/8 ; transcription/timeline ; mouvement réduit ; dépliage des styles et des droits ; verrouillage du rendu avant consentements ; bouton de rendu dans la maquette protégée ; retour à l’import via « Nouveau projet ».

Aucune erreur de console applicative observée pendant ces contrôles. Les avertissements de rechargement à chaud du serveur de développement ne sont pas des erreurs d’exécution de l’interface.

## Écarts intentionnels, données et sécurité

- Les filtres s’appuient sur les champs existants : sélection réelle, score, questions dans le texte et ambiance playful (« Ton léger »). Les catégories et les compteurs fictifs de Canva ne sont pas présentés comme des résultats de l’IA.
- Les avatars représentent l’utilisateur connecté ou un état neutre, pas des membres d’équipe inventés.
- Sans média local disponible, lecture, déplacement dans la vidéo et plein écran sont désactivés et expliqués. La photo de Canva n’est jamais substituée au média d’un vrai projet.
- Le contrat courant fournit un extrait de transcription, pas les cues temporels complets. Le vrai studio n’invente ni horodatages par phrase ni forme d’onde. La synchronisation exacte reste une responsabilité du rendu. Les cues et la forme d’onde originales sont visibles uniquement dans la démonstration identifiée comme telle, jamais à la place des données d’un projet utilisateur.
- Le CTA corail reste désactivé tant que les prérequis existants pour la musique ne sont pas remplis. Les consentements ElevenLabs, les droits, les restrictions Opus et la confirmation YouTube sont conservés.
- Le nouveau lecteur utilise le fichier choisi pendant la session. Le rechargement d’un projet depuis la bibliothèque ne fournit pas encore une URL média au composant ; cette limite d’intégration n’est pas dissimulée par des portraits de démonstration.

## Preuves locales

- Suite du dépôt : **637 tests réussis, 78 fichiers**.
- TypeScript, ESLint, formatage et compilation de production vérifiés.
- Tests ajoutés : filtres et tri sans mutation du classement serveur ; recherche accentuée ; états source/analyse/échec ; durée lisible ; rendu HTML sans faux résultats ; exclusion des médias et des cues de maquette du vrai studio ; démonstration explicite en lecture seule en production ; états sélection/import, français/anglais et absence d’indexation.
- Compilation isolée dans .next-clipsflow-local-smoke pour préserver le serveur de développement ouvert. Les ajouts automatiques de chemins temporaires au tsconfig.json ne sont pas conservés.
- Aucune migration Supabase, modification de clé, activation de budget IA ou publication YouTube effectuée dans cette retouche.

Captures :

- C:/Users/adama/AppData/Local/Temp/clipsflow-fidelity-desktop-final.jpg
- C:/Users/adama/AppData/Local/Temp/clipsflow-canva-comparison.png
- C:/Users/adama/AppData/Local/Temp/clipsflow-intake-wide-final.jpg
- C:/Users/adama/AppData/Local/Temp/clipsflow-fidelity-tablet.jpg
- C:/Users/adama/AppData/Local/Temp/clipsflow-fidelity-mobile.jpg
- C:/Users/adama/AppData/Local/Temp/clipsflow-fidelity-mobile-inspector.jpg

Reproduction : scripts/extract-canva-studio-reference.mjs pour les recadrages de la référence ; scripts/compare-shorts-design.mjs pour la planche côte à côte, qui refuse des captures de dimensions différentes.

## Résultat

Aucun défaut visuel bloquant ouvert dans le périmètre contrôlé. Ce résultat ne prétend ni à une copie pixel parfaite ni à une validation end-to-end des services externes. La retouche est locale tant qu’elle n’a pas été publiée et vérifiée sur Vercel.

final result: passed
