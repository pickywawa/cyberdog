# Bastions SSH — plan de développement et recette

Proposition du 27 octobre 2026. Dépend de la [spécification](./specification.md). Aucun lot ci-dessous n’est implémenté par cette étude ; la [maquette](./maquette.html) simule ses opérations.

## Ordre proposé

| Lot | Livrable | Dépendances | Charge indicative |
|---|---|---|---|
| 0 — preuve technique | Vrai OpenSSH : bastion forwarding-only, deux identités, cible par DNS interne, SFTP et shell, hostVerifier asynchrone et MFA avec timeout maîtrisé. Compte rendu reproductible. | Environnement de test disponible | 1–2 j |
| 1 — fondations | Contrat de transport optionnel public ; résolution privée du plan ; RouteSession et annulation ; connexion directe inchangée. | Lot 0 concluant | 2–3 j |
| 2 — confiance et authentification | Confirmation séparée des empreintes, refus des changements, défis multi-champs/MFA, intégration agent/coffres et nettoyage. | 1 | 2–3 j |
| 3 — première UX locale | Fiche serveur Direct/Via, sélection/recherche/création, loader central, test/cancel/résumé, indicateur de route et erreurs accessibles. | 1–2 ; maquette validée | 2–3 j |
| 4 — sauvegarde et portabilité | Validation à l’écriture et au démarrage, suppression/déplacement avec dépendances, import/export remappant les références, restauration de session. | 3 | 1–2 j |
| 5 — cloud et équipes | Migration, RPC route_get, contrôles licence/membre/droits/scope, verrouillage transactionnel, catalogues, histoire et restauration, révocation/TTL. | 1–4 ; tests SQL | 2–4 j |
| 6 — intégration complète | Tous les outils de cible utilisent le transport ; tests des coffres verrouillés, fermetures, transferts et ouverture simultanée du terminal. | 3–5 | 1–2 j |
| 7 — recette et livraison | OpenSSH réel, applications packagées macOS/Windows, absence de régression Community, documentation et release progressive. | Tous les précédents | 2–3 j |

Ordre de grandeur : **13–22 jours de développement pour une personne**, estimation à réviser après le lot 0 ; ce n’est ni un engagement de délai ni du temps déjà réalisé. Les attentes d’environnement/MFA et la recette des coffres fournisseurs peuvent ajouter du délai. Un premier aperçu local peut être livré avant le lot partagé, explicitement sans partage de routes.

## Décisions figées pour limiter la complexité

- Une seule passerelle, référence à un serveur existant, pas de clé copiée ni d’agent forwarding.
- Aucun port local ouvert pour un simple saut ; canal natif ssh2.
- Pas de réutilisation globale de connexion bastion en V1 : cycle de vie explicite par connexion de destination. Deux ouvertures peuvent provoquer deux MFA.
- Pas de tentative directe si le passage échoue, pas de bastion de secours implicite.
- Route partagée dans le même espace que ses dépendances ; secrets et confiance locaux.
- Pas de reprise automatique d’une commande, d’un transfert interrompu ou d’un terminal après rupture.
- Modal d’empreinte/MFA dans le panneau de l’application, jamais des secrets dans les libellés d’onglets.

## Découpage technique pour revue

1. **Contrat public neutre** : provider de transport et événements de progression ; aucune logique licence/Supabase dans les sources publiques. Tests de démarrage sans extension.
2. **Gestionnaire privé de route** : schéma, résolution, refus des cycles/références, ressources et cleanup ; adaptateur de secrets existant par saut.
3. **Défis SSH** : canal IPC ciblé, identifiants de tentative et de défi non réutilisables, validation du renderer, expiration et annulation.
4. **UI locale** : étendre la fiche et le loader central ; i18n FR/EN/DE/IT ; détails du trajet et test de configuration temporaire.
5. **Migration privée versionnée** : route en schéma relationnel ou colonne contrôlée, index de dépendance, validation transactionnelle, `route_get`, snapshots. Comparer FK nullable + type de route à JSON avant implémentation ; la représentation JSON de la spécification est un contrat d’échange, pas une obligation de stockage SQL.
6. **Compatibilité** : filtres d’export, IDs remappés, déplacement/suppression/restauration, politique fail-closed des anciennes versions officielles. Une ancienne application peut posséder les identifiants SSH : cela ne se résout pas par le format JSON, il faut aussi les restrictions réseau/infrastructure.
7. **Raccordement et recette** : SFTP/terminal/outils/action, verrouillage coffre et révocation ; builds signés ou non selon le processus existant, sans inventer de certification.

Chaque lot reçoit un commit/une revue cohérente, des tests pertinents et une note de migration. Aucun secret de laboratoire ou configuration de production dans les deux dépôts. La migration est additive, les anciennes fiches Direct restent lisibles. Le déploiement backend doit précéder le client partagé.

## Matrice de tests

| Niveau | Scénarios nécessaires | Preuve attendue |
|---|---|---|
| Unitaires | Validation hôtes/ports, références et scope ; auto-référence ; dépendance en chaîne refusée en V1 ; suppression ; import remappé ; annulation à chaque phase ; événements périmés ; nettoyage idempotent ; délais ; erreurs expurgées. | Résultats automatisés, pas de compte fournisseur requis. |
| IPC / UI | Validation de provenance et challenge à usage unique ; cible du prompt correcte ; echo respecté ; focus/Escape ; erreurs par rôle ; fermeture pendant MFA ; formulaire non sauvegardé ; FR/EN/DE/IT ; lecteur d’écran et clavier. | Tests Electron sur profil isolé et captures sans secrets. |
| OpenSSH réel | Deux vrais sshd, forwarding-only sur le bastion ; clé A pour bastion, clé B pour cible ; refus croisés ; mot de passe ; agent local ; clé chiffrée ; plusieurs questions keyboard-interactive via environnement PAM de test ; SFTP et shell final. | Journal de recette identifiant images/versions/configurations et les cas effectivement exécutés. Ne pas qualifier un serveur ssh2 simulé d’OpenSSH réel. |
| Réseau réel isolé | La cible est injoignable directement ; DNS cible seulement depuis réseau bastion ; IPv4/IPv6 si disponibles ; ports non standard ; refus PermitOpen/AllowTcpForwarding ; timeout ; coupure bastion ; absence de shell bastion ; changement d’empreinte de chaque saut. | Laboratoire à deux réseaux, captures de routes et résultats. Si IPv6/MFA indisponible : cas marqué non testé, pas coché par analogie. |
| Cloud / SQL | Appel sans licence, identité falsifiée, membre révoqué, lecture seule, autre équipe, accès personnel d’autrui ; deux écritures concurrentes ; suppression/déplacement référencé ; restauration vers dépendance supprimée ; TTL expiré et veille/reprise. | Jeux synthétiques rollbackés et appels réels à la passerelle ; accès interdit vérifié côté serveur. |
| Coffres | Secrets récupérés au moment de chaque saut ; rotation ; verrouillage du bastion coupe la cible ; verrouillage cible n’affecte pas les connexions indépendantes ; contenu absent des logs/exports. | Tests simulés + recette d’au moins un vrai coffre disponible. Marquer séparément les fournisseurs non testés réellement. |
| Livraison | App macOS arm64/Intel et Windows ; connexion vers laboratoire autorisé ; démarrage gratuit direct sans module privé ; transferts/éditeur/actions/monitoring/terminaux ; pas de sockets orphelins après 50 cycles d’annulation/connexion. | Rapport des plateformes et architectures réellement lancées, distinct d’un simple build réussi. |

## Laboratoire recommandé

Un environnement Linux jetable, avec deux instances OpenSSH et réseaux isolés, comptes et clés de test exclusivement. Le client ne doit pas pouvoir joindre le port cible directement. La cible peut héberger des fichiers synthétiques pour téléchargement/upload vérifiés par SHA-256. Le bastion autorise uniquement le port cible choisi et refuse les sessions shell/subsystem.

Sur CI Linux, des conteneurs avec configurations/version explicites peuvent fournir ce laboratoire. Pour l’application packagée Windows/macOS, utiliser un laboratoire éphémère autorisé joignable par les runners/postes concernés ; ne pas supposer que Docker Linux ou PAM sont disponibles sur un runner Windows. Préparer une variante OpenSSH native si besoin, avec les limites de parité documentées. Aucun changement du SSH système du poste personnel.

Le MFA synthétique en laboratoire valide le protocole keyboard-interactive ; il ne prouve pas une certification Duo/Okta/Entra ou la compatibilité de tous les PAM. Un pilote d’entreprise peut compléter cette recette avec des comptes dédiés et consentis.

## Portes de sortie

- **Avant développement fonctionnel** : résultat lot 0 et accord sur le périmètre/UX ; l’analyse présente n’est pas cet accord automatique.
- **Avant pilote local** : vrais SSH/SFTP via bastion, confiance et MFA fonctionnels, annulation sans fuite, retour direct impossible.
- **Avant partage** : contrôles SQL/API réussis, références atomiques, historique/export, révocation et limite d’autorité documentées.
- **Avant release stable** : recette packagée sur macOS et Windows, compatibilité annoncée bornée aux cas testés, sauvegarde des configurations existantes et procédure de retour à la version précédente.

## Risques à suivre

1. MFA et timeout : interaction de ssh2 avec les timers ; résoudre au prototype, pas après l’UI.
2. Connexions secondaires : tout outil qui réouvre SSH doit passer par le plan ; inventaire de tous les appels obligatoire.
3. Références et secrets : changements d’endpoint/scope/identité invalidant les bindings ; pas de réutilisation d’un jeton pour une nouvelle destination.
4. Suppression concurrente et droits : résolution autoritative, verrouillage SQL et fermeture côté client ; aucune garantie de révocation d’une clé SSH déjà détenue.
5. Anciennes versions : elles peuvent ignorer le champ route ; bloquer leurs opérations partagées incompatibles et ne pas considérer l’application comme la frontière de sécurité réseau.
6. Noms « bastion » commerciaux : agents/gateways/PAM propriétaires demandent une intégration distincte ; afficher la portée « bastion SSH standard ».

## Validation des livrables de conception — effectuée

La maquette a été ouverte dans le navigateur et dans Electron, sans modifier l’application. Scénarios exercés : succès simulé, refus du canal, empreinte cible changée, SSH sans SFTP, droits révoqués, MFA fictif validé, première empreinte acceptée, annulation par bouton et Échap, passage Direct/Via, création d’une passerelle en mémoire et thème clair. Affichage vérifié à 390 px de large sans débordement horizontal. Une [capture Dracula](./maquette.png) est jointe.

Ces vérifications portent sur la maquette seulement. Aucune connexion bastion réelle, migration Supabase, modification de l’authentification, publication ou release n’a été réalisée pour cette étude.
