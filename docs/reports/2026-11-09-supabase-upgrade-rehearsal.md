# Répétition isolée de la mise à niveau Supabase

Le workflow `supabase-upgrade-rehearsal.yml` ne reçoit aucun secret de production,
aucun jeton Supabase et aucune cible distante. Son script refuse un projet lié.
La seule base SQL accessible au script est 127.0.0.1:55322, créée dans le runner.

Il reconstruit les onze migrations initiales jusqu'au 30 septembre, vérifie les
huit tables de départ et insère une fixture fictive. Le test d'acceptation doit
échouer avant mise à niveau avec UPGRADE_NOT_APPLIED. Il applique ensuite les
17 fichiers suivants par la CLI locale, vérifie la conservation de la fixture,
la protection des tables privées, les fournisseurs audio autorisés et les
limites de stockage, puis exécute les tests SQL existants.

Le nettoyage et la remise des fichiers déplacés ne concernent que le checkout
éphémère. Aucun fichier du dépôt distant n'est supprimé et aucun modèle IA n'est
appelé. Le script n'est pas un script de migration de production.

Une répétition réussie ne prouve pas que les bases manuelles accessibles sont
identiques au baseline : la comparaison de schéma et la sauvegarde restent
requises avant toute migration hébergée. Elle ne prouve pas non plus que la
limite globale du plan Storage autorise 8 Gio : elle vérifie le contrat SQL local.

Vérification locale disponible : syntaxe Bash valide et refus hors CI avec le
code 78. Le SQL et les conteneurs doivent être vérifiés par le run GitHub ;
le résultat distant sera enregistré après son exécution, sans succès présumé.
