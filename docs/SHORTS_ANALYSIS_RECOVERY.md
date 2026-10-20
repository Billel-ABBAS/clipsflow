# Sonde de récupération du worker d'analyse Shorts

Le workflow `Shorts analysis recovery` exécute le worker existant au commit
testé `e2592d7` sur GitHub Actions, indépendamment de Railway. Il ne remplace
pas une disponibilité continue du service; aucun cron n'est activé.

L'environnement GitHub `shorts-analysis-recovery` contient uniquement les
trois secrets serveur Supabase, OpenAI et Groq nécessaires. Les secrets ne
sont fournis qu'à l'étape d'exécution, après installation des dépendances.
Ni les vidéos, ni les transcriptions, ni les sorties brutes du worker ne
sont publiées comme artefacts ou journaux. Le dépôt est public; les journaux
ne contiennent que la provenance du run et le résultat du worker.

Précondition opérateur : vérifier que le gate Vercel est absent/fermé et le
maintenir fermé pendant le run. `probe` lance le vrai consommateur; le GET
préalable ne verrouille pas la file contre une insertion concurrente.

Le push initial sur la branche dédiée ne lance que `probe` : la file doit
être vide avant et après l'appel réel du worker; le résultat doit être `idle`
et la sonde doit voir un heartbeat frais. Ce résultat ne prouve pas un appel
IA ni le parcours complet. Le heartbeat est écrit par le vrai chemin du
worker après son poll réussi, jamais directement par le script de secours.

Le traitement de jobs est exclu de ce premier lot; seul `idle` est accepté.
Le poll est borné à 90 secondes. Le déclenchement manuel ne sera disponible
qu'après présence du workflow sur la branche par défaut; le premier probe
utilise le push de la branche dédiée, sans fusion de code en Production.

Le gate Vercel, les migrations, le rendu et YouTube ne sont pas modifiés.
L'admission contrôlée et les médias réels demandent leur recette distincte.
Ne pas déduire d'un heartbeat frais que le worker sera encore disponible
quinze minutes après la fin du run. Avant toute bascule durable, mesurer la
durée, le disque et la qualité sur les médias autorisés, puis définir la
cadence et le coût. Sur Railway, ne pas rejouer le patch déjà appliqué.
