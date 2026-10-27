# Coffres de secrets — Premium

L’onglet **Paramètres → Coffres de secrets**, identifié par une étoile Premium, permet d’ajouter un coffre, de parcourir ses entrées et de choisir celles à afficher. Chaque coffre possède sa section dans la liste. Un raccourci fixe le nom, l’hôte, le port et l’utilisateur SSH ; son bouton crayon modifie cette cible localement.

Les identifiants sont lus à chaque ouverture SFTP ou terminal. Les changements de mot de passe sont donc pris en compte à la prochaine connexion, sans toucher aux connexions déjà établies. Les cibles des raccourcis ne changent pas automatiquement lorsque l’entrée du coffre est modifiée. Il faut modifier explicitement le raccourci pour changer de serveur ou de compte SSH.

Les implémentations des connecteurs, leur interface, la gestion des licences, des équipes et de l’historique résident dans le dépôt privé. Le dépôt public ne contient que les points d’intégration et un écran de présentation.

## Connecteurs disponibles

| Coffre | Accès utilisé | Préparation |
| --- | --- | --- |
| 1Password | CLI officiel `op`, intégration avec l’application desktop | Installer le CLI et activer son intégration dans les paramètres développeur de 1Password. Choisir éventuellement un compte et un coffre. |
| Bitwarden / Vaultwarden | CLI officiel `bw`, session déverrouillée | Configurer et connecter le CLI, puis coller la clé de session issue de `bw unlock`. |
| HashiCorp Vault | API HTTPS KV v2, jeton et namespace facultatif | Donner l’adresse, le point de montage, le dossier et un jeton limité à la lecture. |
| AWS Secrets Manager | CLI officiel `aws`, profil local | Installer AWS CLI, configurer son profil et sa région ; les profils SSO doivent être connectés au préalable. |
| Azure Key Vault | API HTTPS Azure, jeton utilisateur en mémoire | Indiquer le nom du coffre Azure public et un jeton destiné à `https://vault.azure.net`. |
| TeamPass 3.2 | API REST v1, JWT Bearer | URL HTTPS, jeton de lecture et identifiants des dossiers autorisés. |
| Keeper Secrets Manager / PAM | CLI officiel `ksm` | Initialiser un profil Secrets Manager avec accès aux entrées souhaitées. |
| ManageEngine Password Manager Pro | API Enterprise, AUTHTOKEN | Adresse HTTPS, jeton REST et organisation éventuelle ; aucun contournement des approbations. |
| Devolutions Server | API, identité applicative | AppKey, AppSecret, identifiant de coffre ; entrées Credentials prises en charge, pas PasswordList. |
| Remote Desktop Manager | Module Devolutions.PowerShell | Windows uniquement, PowerShell 7, source de données et dépôt déjà configurés. |

Pour les CLI, un chemin absolu vers l’exécutable peut être renseigné si la détection automatique ne le trouve pas. Sous Windows, utiliser les exécutables natifs `op.exe` et `bw.exe` ; les lanceurs npm `.cmd` ne sont pas exécutés. Les erreurs des CLI sont remplacées par des messages génériques pour éviter qu’une sortie d’erreur contenant un secret ne soit affichée.

### 1Password

L’autorisation reste gérée par 1Password. Cyberdog utilise `op item list`, `op item get` et, pour les entrées de type clé SSH, `op read` avec le format OpenSSH. Le cache CLI est désactivé pour ces commandes. Un compte et un coffre peuvent être sélectionnés pour limiter le périmètre de recherche. Il n’est pas nécessaire de donner le mot de passe maître à Cyberdog.

Documentation officielle : [CLI et entrées](https://developer.1password.com/docs/cli/reference/management-commands/item/), [références de secrets et formats SSH](https://developer.1password.com/docs/cli/secret-reference-syntax/).

### Bitwarden et Vaultwarden

Configurer le serveur du CLI, si nécessaire, **avant de s’y connecter**. Pour Vaultwarden, il s’agit de l’adresse HTTPS de votre instance, utilisée par le CLI Bitwarden ; la compatibilité dépend aussi de la version de cette instance.

Après connexion du CLI, `bw unlock --raw` fournit une clé de session à coller dans le champ dédié. Cette clé est sensible : elle permet le déchiffrement du coffre et reste uniquement en mémoire dans Cyberdog pour ce lancement. Ce n’est ni le mot de passe maître ni une clé API d’organisation. Au lancement suivant, il faut fournir une nouvelle session. Le compte utilisé est celui configuré dans le CLI ; plusieurs connecteurs Bitwarden peuvent appliquer des filtres différents au même compte, mais ne créent pas de comptes CLI indépendants.

Avant de parcourir ou lire une entrée, Cyberdog exécute `bw sync` afin de récupérer les modifications effectuées ailleurs. Les commandes qui accèdent au coffre reçoivent la session par variable d’environnement, jamais comme argument de ligne de commande. La liste renvoyée par `bw list items` contient des données déchiffrées dans le processus principal ; seuls les noms et identifiants d’entrées passent à l’interface. Le cache chiffré du CLI reste géré par Bitwarden.

Documentation officielle : [CLI et sessions](https://bitwarden.com/help/cli/), [synchronisation](https://bitwarden.com/help/vault-sync/).

### HashiCorp Vault

Seul **KV v2** est pris en charge ici. Ce connecteur ne délivre pas de certificats SSH dynamiques et n’implémente pas les méthodes de connexion OIDC/AppRole. Utiliser un jeton de lecture avec une durée adaptée et un périmètre limité.

Exemple pour le point de montage `secret` et le dossier `servers` :

```hcl
path "secret/metadata/servers" {
  capabilities = ["list"]
}
path "secret/metadata/servers/*" {
  capabilities = ["list"]
}
path "secret/data/servers/*" {
  capabilities = ["read"]
}
```

L’adresse doit être une origine HTTPS, par exemple `https://vault.example.com:8200`. Le namespace possède son propre champ. Les redirections sont refusées et la validation TLS reste active. La lecture des dossiers est limitée à 100 requêtes et environ 1 000 entrées ; choisir un dossier plus précis au-delà. La taille des réponses est bornée.

Le jeton reste en mémoire par défaut. Une case facultative permet de le mémoriser dans le stockage chiffré local de Cyberdog. **Verrouiller** interdit sa réutilisation dans Cyberdog et ferme les connexions provenant de ce coffre, même s’il était mémorisé. Le déverrouillage peut alors réutiliser le jeton enregistré en laissant le champ vide. Cette action ne révoque pas le jeton auprès de Vault.

Documentation officielle : [API KV v2](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2), [politiques et droits](https://developer.hashicorp.com/vault/docs/concepts/policies).

## AWS Secrets Manager et Azure Key Vault

AWS utilise le profil et la région configurés, avec les droits `secretsmanager:ListSecrets` et `secretsmanager:GetSecretValue`, ainsi que `kms:Decrypt` si la clé KMS l’exige. Aucun identifiant AWS n’est demandé ou mémorisé par Cyberdog. Un préfixe peut limiter la liste. Les valeurs doivent être des `SecretString` : objet JSON avec les champs ci-dessous ou simple mot de passe. Le connecteur lit la version `AWSCURRENT`. Les secrets binaires ne sont pas pris en charge.

Azure demande le nom du coffre et un jeton temporaire destiné au service Key Vault. Il peut être obtenu après `az login` avec :

```sh
az account get-access-token --resource https://vault.azure.net --query accessToken --output tsv
```

Coller ce jeton sensible dans Cyberdog ; il reste en mémoire et doit être renouvelé lorsqu’il expire. Les droits Azure doivent autoriser la liste et la lecture des secrets. Seul Azure public (`*.vault.azure.net`) est pris en charge, pas les clouds souverains. Les secrets désactivés ne sont pas proposés. Les pages suivantes sont contrôlées pour ne jamais transmettre le jeton à une autre origine. Les valeurs peuvent être des objets JSON ou de simples mots de passe ; dans ce dernier cas, saisir manuellement la cible SSH lors de l’ajout.

Documentation officielle : [AWS GetSecretValue](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/get-secret-value.html), [Azure secrets list/show](https://learn.microsoft.com/en-us/cli/azure/keyvault/secret?view=azure-cli-latest).

## Champs des entrées

Le bouton **Correspondance des champs** permet d’indiquer les noms exacts de champs personnalisés. Un champ laissé vide utilise les noms habituels :

| Information | Noms par défaut |
| --- | --- |
| Hôte | `host`, `hostname`, `server`, `address` |
| Utilisateur SSH | `username`, `user`, `login` |
| Port | `port`, sinon `22` |
| Mot de passe | `password`, `pass` |
| Clé privée | `private_key`, `privateKey` |
| Phrase secrète de la clé | `passphrase` |

Les identifiants Login et clés SSH natives de Bitwarden sont reconnus. Une URL `ssh://` ou `sftp://` peut fournir l’hôte, le port et l’utilisateur dans les entrées Login. Les clés SSH natives 1Password sont demandées au format OpenSSH. Une entrée clé seule peut nécessiter de saisir manuellement la cible SSH lors de l’ajout du raccourci.

Exemple d’entrée KV v2 :

```json
{
  "host": "server.example.com",
  "port": "22",
  "username": "deploy",
  "password": "valeur-conservee-dans-vault"
}
```

## Stockage et limites

- Les connecteurs, raccourcis et empreintes des serveurs résident dans un fichier chiffré par le système, dans le profil local de l’application. Le stockage en texte clair de secours sous Linux est refusé.
- Aucun mot de passe SSH, clé privée ou phrase secrète lu depuis une entrée n’est enregistré par Cyberdog ni envoyé à son interface. Ils sont utilisés en mémoire pour la connexion SSH. Les logiciels fournisseurs conservent leurs propres caches et sessions.
- Les connecteurs et raccourcis sont exclus des exports de configuration, des transferts vers une équipe et de Supabase. Les fichiers déjà téléchargés par SSH restent des fichiers ordinaires locaux.
- L’activation Premium existante est vérifiée avant les opérations d’accès au coffre. Cette vérification utilise le backend de licence, sans transmettre de contenu du coffre. Une vérification qui échoue ne donne pas accès aux secrets.
- Retirer une entrée de Cyberdog ne supprime jamais le secret chez son fournisseur. Verrouiller dans Cyberdog ne verrouille pas l’application 1Password/Bitwarden et ne révoque pas les autorisations externes.
- La confiance initiale et le contrôle de l’empreinte SSH restent actifs. Changer la cible d’un raccourci réinitialise son empreinte ; renommer seulement le raccourci la conserve.

## Autres coffres étudiés

Ces adaptateurs ne sont **pas encore implémentés** :

| Solution | Intégration envisageable |
| --- | --- |
| KeePassXC | Adaptateur local au CLI, avec prise en charge spécifique de l’ouverture du fichier KDBX et du déverrouillage. [Guide officiel](https://keepassxc.org/docs/KeePassXC_UserGuide) |
| Passbolt | Authentification JWT et déchiffrement OpenPGP côté client ; nécessite une gestion explicite des clés utilisateur. [Authentification officielle](https://www.passbolt.com/docs/development/authentication/) |

L’architecture sépare le stockage local, la normalisation des champs et les adaptateurs de lecture pour pouvoir ajouter ces fournisseurs sans convertir leurs secrets en serveurs Supabase.

## Vérifications

`npm test` dans le dépôt public valide le fonctionnement gratuit et l’absence d’implémentations Premium dans ses sources. `npm test` dans le dépôt privé valide les dix adaptateurs, les permissions et le stockage.

Après `npm run premium:install`, lancer depuis le dépôt public `npx electron ../cyberdog-premium/smoke/vaults-ui.cjs` pour les tests SFTP/SSH isolés ; `npx electron test/manual/settings-ui.cjs` teste une copie publique sans aucun module privé. Les comptes réels des fournisseurs doivent être validés avec leurs propres autorisations.

### Connecteurs d’entreprise et validation

TeamPass utilise `/api/v1` (3.2), pas l’ancienne API. Keeper utilise un profil `ksm` initialisé. Password Manager Pro exige l’édition Enterprise et ses permissions REST ; les comptes nécessitant une approbation peuvent refuser la lecture. Devolutions Server ouvre une session applicative limitée à un coffre, puis la ferme après chaque opération. RDM exige Windows et une source en ligne accessible au module PowerShell ; il n’ouvre pas les fichiers exportés.

Les jetons restent en mémoire par défaut. Un changement d’adresse ou d’identité du connecteur invalide les anciens identifiants mémorisés. Les logos officiels sont embarqués localement et restent la propriété de leurs marques.

Le bac à sable `smoke/vault-protocol-sandbox.cjs` du dépôt privé teste les API sur un serveur HTTPS local avec autorité de certification temporaire, et les CLI dans des processus isolés. Il vérifie lecture, rotation, refus, verrouillage et validation TLS. Ces simulations de protocoles ne remplacent pas une recette sur les produits fournisseurs. RDM est testé par contrat Windows simulé, sans installation native sur le Mac de développement.
