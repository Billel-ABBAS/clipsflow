# Clipsflow — second compte Supabase : audit et reprise

## Résultat constaté le 9 novembre 2026

Le deuxième compte permet désormais l'accès aux deux projets documentés dans
`docs/OPERATIONS.md`. Ils étaient inactifs. Leur remise en service a été demandée,
puis leur état `ACTIVE_HEALTHY` confirmé séparément et des SELECT ont réussi.

| Cible | Référence | Résultat |
|---|---|---|
| clipsflow-staging | nbktlyedezpkyamgjmhy | Réactivée, accessible, schéma audité |
| clipsflow-production | hkbzphqdplddlvlkbxus | Réactivée, accessible, schéma audité |
| Référence utilisée par Railway | ifwdzqzoqwitahffrvcr | Toujours distincte ; accès de gestion refusé dans ce deuxième compte |

Aucune URL ni clé Railway n'a été remplacée. Ces projets ne sont pas déclarés
équivalents à la base encore utilisée par l'application. Aucun effacement,
rechargement de données ou changement de plan payant n'a été effectué.

## Schéma réellement observé

Les deux bases contiennent les huit tables publiques suivantes, toutes avec RLS
activée et forcée : ai_disclosure_events, api_rate_limits, clips,
clips_budget_guard, episodes, jobs, profiles, stripe_webhook_events.

- `public.shorts_audio_assets` et les autres tables Shorts/YouTube sont absentes.
- `supabase_migrations.schema_migrations` est absente : ne pas lancer `db push`
  aveuglément ni marquer des migrations appliquées sur la seule présence des tables.
- Les sept RPC Clips examinées ne sont exécutables ni par `anon` ni par
  `authenticated`, et restent exécutables par `service_role`.
- Les buckets `clip-sources` et `clip-outputs` sont privés et limités à
  524 288 000 octets (500 Mio), pas 8 Gio. Ne pas augmenter cette limite sans
  valider les capacités, le coût et les plafonds de la plateforme.
- Des données existent déjà. Leur contenu et les identifiants utilisateurs ne
  sont pas publiés dans ce rapport.

La migration audio seule ne peut donc pas être appliquée directement : elle
suppose une table Shorts qui n'existe pas dans ces deux bases.

## Sécurité

Les advisors de sécurité des deux projets ont été consultés. Ils signalent
notamment l'absence de protection contre les mots de passe compromis et les
droits d'exécution de `rls_auto_enable()`. En staging, cette fonction retourne
`event_trigger` et est attachée à `ensure_rls` ; aucune révocation aveugle d'une
fonction de plateforme n'a été faite. Les tables privées sans politique RLS ne
sont pas automatiquement des fuites : les droits effectifs doivent être examinés.

Références de remédiation de l'advisor :
- https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable
- https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable
- https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## Livrables vérifiés

`scripts/supabase-schema-audit.sql` conserve l'inventaire en lecture seule,
sans lire les lignes utilisateurs ou les valeurs de secrets.

`scripts/supabase-target-preflight.mjs` exige une référence cible explicite,
vérifie sa cohérence avec l'URL et les indications des anciennes clés JWT,
et refuse notamment une clé administrative dans l'emplacement public.
Les clés opaques modernes restent supportées mais leur rattachement au projet
nécessite un vrai contrôle réseau. Décoder un JWT n'authentifie pas ce JWT.

Commande hors réseau, avec l'environnement injecté par le gestionnaire de secrets :
`node scripts/supabase-target-preflight.mjs web`.
La variable `CLIPS_EXPECTED_SUPABASE_PROJECT_REF` est obligatoire pour ce contrôle.
Ne changer aucune URL tant que les clés et la base de destination ne sont pas validées.
Ce contrôle reste autonome : il n'a pas été activé sur les déploiements existants.

Test local : 10 tests réussis, zéro échec. Une première version volontairement
incomplète avait produit 9 échecs d'assertion et 1 réussite avant implémentation.
Ces tests ne prouvent ni l'authentification distante, ni une migration, ni une
inférence audio. Une CI sans secrets est ajoutée pour rejouer les mêmes tests.

## Plan mis à jour : ce qui reste effectivement

1. Réconcilier le schéma manuel et l'historique sur la cible explicitement retenue,
   après comparaison des objets et sauvegarde. Le canal MCP reste read-only ;
   le workflow de migration documenté requiert des accès dédiés et une sauvegarde.
2. Établir la continuité des données avec `ifwdzqzoqwitahffrvcr` avant de remplacer
   la destination de l'application. L'accès aux projets homonymes ne prouve pas
   qu'ils portent toutes les données du service actuellement utilisé.
3. Préparer puis appliquer les migrations manquantes dans l'ordre, d'abord en
   staging. Ne pas rejouer les sept migrations initiales sur le schéma manuel.
4. Configurer ensemble URL, clés et callbacks du projet retenu ; vérifier les
   comptes, les droits, l'import et le stockage avant de déployer les consommateurs.
5. Valider un budget CPU/RAM/disque pour l'inférence et les artefacts des modèles,
   puis installer et tester VoiceStudio/Soundbox. Aucun service audio n'a été lancé.
6. Valider le parcours complet, fusionner le code revu et basculer la production.

La connexion du deuxième compte et l'audit des deux bases sont terminés. La
migration des données, la génération IA et la bascule de production ne le sont pas.
