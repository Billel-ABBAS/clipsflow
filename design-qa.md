# QA design — extension de la direction Canva aux 11 écrans

Date : 7 octobre 2026. Direction : dernière maquette Canva Studio approuvée, étendue aux 11 routes sans copier la composition de l’éditeur sur les écrans marketing ou compte. Aucun visuel ni portrait n’a été généré pendant cette extension.

## Références et preuves

- Source visuelle conservée dans le dépôt : `public/images/shorts-reference/canva-studio-selection.png`, issue de la maquette sélectionnée par l’utilisateur.
- Système visuel partagé : `.superdesign/design-system.md` ; couverture des routes : `.superdesign/init/routes.md`.
- Comparaison pleine page historique de la maquette et de l’implémentation : `C:/Users/adama/AppData/Local/Temp/clipsflow-canva-comparison.png` (**2998 × 1106 px**, deux panneaux côte à côte). Référence fournie : **1487 × 1058 px**. La comparaison de Studio déjà enregistrée dans le rapport du 6 octobre reste l’évidence de fidélité la plus précise.
- Captures en direct de cette passe via le navigateur intégré : Studio, landing, tarifs, connexion et récupération de mot de passe à **1280 × 720 px** (viewport CSS observé, densité 1). Elles ont été inspectées dans le navigateur mais ne sont pas persistées dans le dépôt ; la planche comparative ci-dessus est la capture persistée disponible.
- État Studio : `/fr/shorts-preview`, sélection, données de démonstration explicitement signalées et contrôles nécessitant un média réel désactivés. L’image de prévisualisation reste celle fournie par la référence.

## Couverture des 11 routes

|   # | Route                      | État de vérification local                                                                      | Présentation appliquée                                                                                                        |
| --: | -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
|   1 | `/[locale]`                | Visuelle, publique, 1280 × 720                                                                  | En-tête de marque, fond nuit, aperçu Canva original, accents violet/cyan et contenu orienté parcours.                         |
|   2 | `/[locale]/dashboard`      | Protégée : redirection vers la connexion                                                        | Navigation workspace, cartes métriques et activité partagée avec les tokens du Studio.                                        |
|   3 | `/[locale]/clips`          | Protégée : redirection vers la connexion                                                        | Bibliothèque/historique dans la coque de navigation commune.                                                                  |
|   4 | `/[locale]/clips/new`      | Protégée : redirection vers connexion ; retour `/clips/new` désormais conservé                  | Création de clip dans la coque commune ; cible de connexion vérifiée dans le navigateur.                                      |
|   5 | `/[locale]/shorts`         | Protégée et feature-gated : redirection vers connexion                                          | Studio fonctionnel conservé séparément de la démonstration publique.                                                          |
|   6 | `/[locale]/shorts-preview` | Visuelle ; comparaison Studio enregistrée                                                       | Traduction du layout Canva, données de démonstration isolées, contrôles d’action explicitement inactifs.                      |
|   7 | `/[locale]/pricing`        | Visuelle, publique, 1280 × 720                                                                  | Grille des quatre offres sur surfaces nuit, boutons et bordures cohérents.                                                    |
|   8 | `/[locale]/login`          | Visuelle, publique, 1280 × 720                                                                  | Marque, formulaire et états auth dans le thème global.                                                                        |
|   9 | `/[locale]/reset-password` | Visuelle à 1280 × 720 : état lien invalide/expiré                                               | Même système visuel ; message d’erreur et retour à la connexion, aucun formulaire actif inventé sans session de récupération. |
|  10 | `/[locale]/share/[token]`  | Non visualisable sans lien partagé réel ; un jeton volontairement invalide donne le 404 attendu | Page de lecture privée conservée dans la direction de marque ; pas de jeton de partage créé ou exposé pour le test.           |
|  11 | `/[locale]/admin`          | Protégée : sans session, redirection locale vers `/login?next=%2Fdashboard`                     | Coque commune et cartes de métriques ; données non consultées et accès non contourné.                                         |

Les pages protégées n’ont pas été ouvertes par contournement d’authentification. Le partage n’a pas été testé avec un lien d’utilisateur. La couverture visuelle des 11 pages n’est donc pas certifiée, même si la direction et ses composants partagés sont présents dans le code local.

### Revalidation locale du 7 octobre

- Parcours du navigateur sur les **11 routes** : landing, dashboard, bibliothèque, création de clip, Shorts, aperçu, tarifs, connexion, récupération, partage et admin.
- Les routes dashboard, bibliothèque, création, Shorts et admin sont restées derrière leur contrôle d’accès ; les destinations de retour de connexion ont été observées. Aucun accès privé n’a été simulé.
- L’aperçu public, les tarifs, la connexion et l’état de récupération expirée ont été capturés visuellement dans le navigateur local. Le partage avec un jeton synthétique invalide renvoie le 404 prévu ; aucun jeton réel n’a été utilisé.
- Contrôles exécutés dans cette reprise : **655 tests / 81 fichiers**, `pnpm typecheck`, `pnpm lint` et `git diff --check` réussis.
- Superdesign : draft actif confirmé en **version 10**. Vérification en lecture seule seulement ; aucune nouvelle génération ni crédit consommé.

## Revue des surfaces de fidélité

- **Typographie :** Geist est utilisé globalement ; hiérarchie claire entre titres, libellés et texte secondaire sur les quatre écrans publics vus. Les textes denses du Studio restent conformes à la capture de comparaison existante.
- **Espacement et rythme :** l’éditeur conserve ses trois zones, tandis que la landing, les tarifs et l’auth gardent leurs propres structures. Le Studio s’adapte par défilement interne au viewport 1280 × 720 ; les mesures précédentes à 1150, 1024 et 390 px sont conservées dans le contrôle historique.
- **Couleurs et tokens :** les écrans visibles partagent la toile bleu nuit, panneaux bleu ardoise, bordures froides et accents violet/corail/menthe. Le layout localisé active le thème sombre sémantique.
- **Images et icônes :** l’image de démonstration et le logo réutilisent les ressources fournies/existantes ; aucun portrait remplacé ou produit par génération. Les icônes d’interface restent celles de la bibliothèque existante.
- **Copy et états :** les pages publiques reprennent l’offre ClipsFlow et le parcours « source → analyse → sélection → rendu → confirmation YouTube ». Le studio démo indique clairement sa nature en lecture seule. Les portes d’accès et l’état de récupération expirée restent explicites.

## Comparaison et correctif de parcours

- La planche comparative source/Studio a été rouverte et vérifiée côte à côte. Aucun nouveau décalage P0/P1/P2 visuel n’a été observé sur le Studio dans cette passe ; le contrôle précédent documente les détails et les breakpoints.
- Le contrôle direct de `/fr/clips/new` a révélé un retour après connexion vers `/dashboard` au lieu de la route demandée. `/clips/new` a été ajouté à la liste stricte de destinations internes autorisées ; le navigateur confirme maintenant `/fr/login?next=%2Fclips%2Fnew`. Aucun chemin arbitraire ou paramètre de destination n’est autorisé par cette correction.
- Contrôles locaux après correction : **655 tests réussis (81 fichiers)**, TypeScript et ESLint passent ; le test ciblé de retour auth passe également. Build de production non relancé dans cette passe.

## Écarts et étapes restantes

- Aucun défaut visuel P0/P1/P2 n’est constaté sur les routes publiques vérifiées. Les écrans Dashboard, Historique/Bibliothèque, création, Studio authentifié, partage avec jeton valide et Admin restent à capturer avec une session et un rôle adaptés.
- Pour la comparaison exhaustive des 11 écrans, il faut une session authentifiée dans le navigateur local (et un lien de partage de test non sensible pour la route Share). Aucune donnée d’utilisateur ni connexion n’a été fabriquée.
- Le déploiement production reste séparé de cette passe : deux migrations Supabase présentes dans la branche n’ont pas reçu la confirmation d’application demandée précédemment.

**Résultat de cette extension :** validation partielle, vérification visuelle des écrans privés bloquée par l’absence de session. Le résultat historique « passed » ci-dessous porte uniquement sur le Studio de sélection au 6 octobre, pas sur les 11 routes.

## Historique — QA du Studio Shorts le 6 octobre 2026

Périmètre : interface réelle de /fr/shorts, état d’import et espace de sélection. Ce contrôle visuel ne vaut pas validation des fournisseurs payants ou de la publication YouTube réelle.

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

## Résultat historique du Studio uniquement

Aucun défaut visuel bloquant ouvert dans le périmètre contrôlé. Ce résultat ne prétend ni à une copie pixel parfaite ni à une validation end-to-end des services externes. La retouche est locale tant qu’elle n’a pas été publiée et vérifiée sur Vercel.

Studio uniquement : passed le 6 octobre 2026.

final result: blocked
