function applyWorkspaceTranslations(D){
 for(const [key,values] of Object.entries({"vault.folder_ids": ["Identifiants des dossiers TeamPass (séparés par des virgules)", "TeamPass folder IDs (comma-separated)"], "vault.jwt": ["Jeton JWT TeamPass", "TeamPass JWT token"], "vault.api_token": ["Jeton API utilisateur (AUTHTOKEN)", "API user token (AUTHTOKEN)"], "vault.organization": ["Organisation PMP (facultatif)", "PMP organization (optional)"], "vault.application_key": ["Clé d’application Devolutions (appKey)", "Devolutions application key (appKey)"], "vault.application_secret": ["Secret d’application Devolutions (appSecret)", "Devolutions application secret (appSecret)"], "vault.remote_vault_id": ["Identifiant du coffre (GUID)", "Vault ID (GUID)"], "vault.cli_profile": ["Profil CLI Keeper initialisé (facultatif)", "Initialized Keeper CLI profile (optional)"], "vault.data_source_id": ["Identifiant de la source RDM (GUID)", "RDM data source ID (GUID)"], "vault.windows_only": ["Cet adaptateur nécessite Windows, PowerShell 7 et le module Devolutions.PowerShell configuré.", "This adapter requires Windows, PowerShell 7 and a configured Devolutions.PowerShell module."], "vault.rate_limited": ["Le coffre limite les requêtes. Réessayez dans quelques instants.", "The vault is rate limiting requests. Try again shortly."], "vault.enterprise_setup": ["TeamPass : API 3.2 JWT activée et dossiers autorisés. KeeperPAM : initialiser le profil ksm Secrets Manager. PMP : compte API et édition Enterprise ; les demandes nécessitant une approbation restent soumises au coffre. Devolutions Server : identité d’application et coffre autorisé, entrées Credentials seulement. RDM : Windows, PowerShell 7 et module Devolutions.PowerShell ; aucune approbation n’est acceptée automatiquement.", "TeamPass: enable the 3.2 JWT API and folder permissions. KeeperPAM: initialize a ksm Secrets Manager profile. PMP: API user and Enterprise edition; approval policies remain enforced. Devolutions Server: application identity and authorized vault, Credentials entries only. RDM: Windows, PowerShell 7 and Devolutions.PowerShell; no automatic approval of prompts."], "vault.kind.onepassword": ["Application + CLI officiel", "Desktop app + official CLI"], "vault.kind.bitwarden": ["Bitwarden ou Vaultwarden · CLI", "Bitwarden or Vaultwarden · CLI"], "vault.kind.hashicorp": ["API KV v2 · jeton de lecture", "KV v2 API · read token"], "vault.kind.aws": ["Profil AWS local · CLI", "Local AWS profile · CLI"], "vault.kind.azure": ["API Azure · jeton temporaire", "Azure API · temporary token"], "vault.kind.teampass": ["API 3.2 · JWT · dossiers", "3.2 API · JWT · folders"], "vault.kind.keeper": ["Profil Secrets Manager · CLI", "Secrets Manager profile · CLI"], "vault.kind.manageengine": ["API Enterprise · utilisateur API", "Enterprise API · API user"], "vault.kind.devolutions": ["API · identité d’application", "API · application identity"], "vault.kind.rdm": ["Windows · PowerShell 7", "Windows · PowerShell 7"]}))for(const language of Object.keys(D))D[language][key]=values[language==='fr'?0:1]

 for(const language of Object.keys(D)){D[language]['vault.setup_title']=language==='fr'?'Préparer la connexion à un coffre':'Prepare a vault connection';D[language]['vault.cloud_setup']=language==='fr'?'AWS : installez aws et configurez le profil choisi. Azure : utilisez un jeton temporaire obtenu avec az account get-access-token --resource https://vault.azure.net --query accessToken --output tsv. Le jeton reste en mémoire et doit être renouvelé à son expiration.':'AWS: install aws and configure the selected profile. Azure: use a temporary token from az account get-access-token --resource https://vault.azure.net --query accessToken --output tsv. The token stays in memory and must be renewed when it expires.'}

 for(const language of Object.keys(D))D[language]['vault.immediate']=language==='fr'?'Les modifications des coffres sont enregistrées immédiatement.':'Vault changes are saved immediately.'

 for(const [key,values] of Object.entries({"vault.azure_vault": ["Nom du coffre Azure", "Azure vault name"], "vault.azure_token": ["Jeton Azure pour https://vault.azure.net", "Azure token for https://vault.azure.net"], "vault.aws_profile": ["Profil AWS (facultatif)", "AWS profile (optional)"], "vault.aws_region": ["Région AWS", "AWS region"]}))for(const language of Object.keys(D))D[language][key]=values[language==='fr'?0:1]

  const ACCOUNT_TRANSLATIONS = {
  "account.email": {
    "fr": "Adresse email",
    "en": "Email address"
  },
  "account.error": {
    "fr": "La demande a échoué. Réessayez ou reconnectez-vous.",
    "en": "Request failed. Retry or sign in again."
  },
  "account.rate": {
    "fr": "Trop de demandes. Patientez avant de réessayer.",
    "en": "Too many requests. Please wait before retrying."
  },
  "account.denied": {
    "fr": "Accès refusé. Vérifiez que vous êtes connecté et votre rôle dans cette équipe.",
    "en": "Access denied. Check that you are signed in and your team role."
  },
  "account.network": {
    "fr": "Connexion au service impossible. Vos serveurs locaux restent disponibles.",
    "en": "Cannot reach the service. Your local servers remain available."
  },
  "account.secure": {
    "fr": "Le stockage sécurisé du système doit être disponible pour se connecter.",
    "en": "Secure system storage must be available to sign in."
  },
  "team.title": {
    "fr": "Mes équipes",
    "en": "My teams"
  },
  "team.create": {
    "fr": "Créer une équipe",
    "en": "Create a team"
  },
  "team.name": {
    "fr": "Nom de l’équipe",
    "en": "Team name"
  },
  "team.empty": {
    "fr": "Créez une équipe pour partager des serveurs.",
    "en": "Create a team to share servers."
  },
  "team.select": {
    "fr": "Équipe",
    "en": "Team"
  },
  "team.local": {
    "fr": "Aucune · serveur local",
    "en": "None · local server"
  },
  "team.local_list": {
    "fr": "Serveurs locaux",
    "en": "Local servers"
  },
  "team.members": {
    "fr": "Membres",
    "en": "Members"
  },
  "team.invitations": {
    "fr": "Invitations",
    "en": "Invitations"
  },
  "team.accept": {
    "fr": "Accepter",
    "en": "Accept"
  },
  "team.cancel": {
    "fr": "Révoquer",
    "en": "Revoke"
  },
  "team.remove": {
    "fr": "Retirer",
    "en": "Remove"
  },
  "team.owner": {
    "fr": "Propriétaire",
    "en": "Owner"
  },
  "team.admin": {
    "fr": "Administrateur",
    "en": "Administrator"
  },
  "team.member": {
    "fr": "Membre",
    "en": "Member"
  },
  "team.rename": {
    "fr": "Renommer",
    "en": "Rename"
  },
  "team.delete": {
    "fr": "Supprimer l’équipe",
    "en": "Delete team"
  },
  "team.leave": {
    "fr": "Quitter l’équipe",
    "en": "Leave team"
  },
  "team.transfer": {
    "fr": "Transférer la propriété",
    "en": "Transfer ownership"
  },
  "team.confirm": {
    "fr": "Confirmer cette action ? La suppression d’une équipe efface ses serveurs partagés pour tous ses membres.",
    "en": "Confirm this action? Deleting a team removes its shared servers for all members."
  },
  "team.permissions": {
    "fr": "Les propriétaires et administrateurs gèrent les serveurs. Les membres peuvent s’y connecter avec leurs propres identifiants SSH.",
    "en": "Owners and administrators manage servers. Members connect using their own SSH credentials."
  },
  "team.loading": {
    "fr": "Chargement…",
    "en": "Loading…"
  }
}
  for (const [key, values] of Object.entries(ACCOUNT_TRANSLATIONS)) for (const language of Object.keys(D)) D[language][key] = values[language] || values.en

  for (const language of Object.keys(D)) Object.assign(D[language], {
    'dialog.close': ({fr:'Fermer',en:'Close',de:'Schließen',it:'Chiudi'})[language] || 'Close',
  })


  const SPACE_TRANSLATIONS = {
  "space.location": {
    "fr": "Emplacement",
    "en": "Location"
  },
  "space.local": {
    "fr": "Local · cet ordinateur",
    "en": "Local · this computer"
  },
  "space.personal": {
    "fr": "Mon espace",
    "en": "My workspace"
  },
  "space.team": {
    "fr": "Équipe · {name}",
    "en": "Team · {name}"
  },
  "team.server_permission": {
    "fr": "Configuration partagée",
    "en": "Shared configuration"
  },
  "team.read_only": {
    "fr": "Lecture seule",
    "en": "Read only"
  },
  "team.write": {
    "fr": "Modification",
    "en": "Can edit"
  }
}
  for(const [key,values] of Object.entries(SPACE_TRANSLATIONS)) for(const language of Object.keys(D)) D[language][key]=values[language]||values.en

  for(const language of Object.keys(D)) D[language]['space.local_copy_kept'] = language==='fr' ? 'La copie locale est conservée. La suppression distante n’a pas pu être confirmée.' : 'The local copy was kept. Remote deletion could not be confirmed.'

  for(const language of Object.keys(D)) D[language]['team.permissions'] = language==='fr' ? 'Le propriétaire définit qui peut ajouter, modifier ou supprimer des serveurs. Les droits sur les fichiers dépendent du compte SSH utilisé.' : 'The owner decides who can add, edit or delete server entries. File permissions depend on the SSH account used.'


  const SHARED_TRANSLATIONS={"shared.review": ["Vérifier le script partagé avant exécution", "Review shared script before running"], "history.title": ["Historique des serveurs", "Server history"], "history.personal": ["Historique de mon espace", "Personal space history"], "history.note": ["Configurations uniquement, sans secrets. L’auteur correspond au compte utilisé. Une restauration crée une nouvelle version.", "Configurations only, without secrets. The author is the signed-in account. Restoring creates a new revision."], "history.more": ["Voir les versions précédentes", "Load older revisions"], "history.restore": ["Restaurer", "Restore"], "history.confirm": ["Restaurer cette configuration ? Les identifiants SSH ne seront pas restaurés.", "Restore this configuration? SSH credentials will not be restored."], "history.empty": ["Aucune modification enregistrée.", "No recorded changes."], "history.unknown": ["Auteur inconnu (configuration existante)", "Unknown author (existing configuration)"], "history.create": ["Création", "Created"], "history.update": ["Modification", "Updated"], "history.delete": ["Suppression", "Deleted"], "history.move": ["Déplacement", "Moved"], "history.baseline": ["Version initiale", "Initial revision"]}
  for(const [key,values] of Object.entries(SHARED_TRANSLATIONS))for(const language of Object.keys(D))D[language][key]=values[language==='fr'?0:1]

  for(const [key,values] of Object.entries({"shared.group_in_use": ["Déplacez d’abord les serveurs de ce groupe avant de changer son emplacement.", "Move the servers out of this group before changing its location."], "shared.invalid_group": ["Le groupe doit appartenir au même espace que le serveur.", "The group must belong to the same workspace as the server."], "shared.invalid_asset": ["Vérifiez le nom, le chemin ou le script saisi.", "Check the name, path or script."], "shared.script_changed": ["Le script partagé a changé. Actualisez puis vérifiez-le avant de le relancer.", "The shared script changed. Refresh and review it before running again."]}))for(const language of Object.keys(D))D[language][key]=values[language==='fr'?0:1]

  const VAULT_TRANSLATIONS={"vault.title": ["Coffres de secrets", "Secret vaults"], "vault.add": ["Ajouter un coffre", "Add vault"], "vault.edit": ["Modifier le coffre", "Edit vault"], "vault.provider": ["Fournisseur", "Provider"], "vault.continue": ["Continuer", "Continue"], "vault.url": ["Adresse HTTPS du coffre", "Vault HTTPS address"], "vault.mount": ["Point de montage KV v2", "KV v2 mount"], "vault.prefix": ["Dossier à parcourir (facultatif)", "Folder to browse (optional)"], "vault.namespace": ["Namespace (facultatif)", "Namespace (optional)"], "vault.token": ["Jeton Vault", "Vault token"], "vault.keep_token": ["Laisser vide pour conserver le jeton enregistré", "Leave blank to keep the saved token"], "vault.remember": ["Mémoriser le jeton, chiffré sur cet ordinateur", "Remember token, encrypted on this computer"], "vault.cli_path": ["Exécutable CLI natif (vide = détection automatique)", "Native CLI executable (blank = automatic detection)"], "vault.account": ["Compte 1Password (facultatif)", "1Password account (optional)"], "vault.filter": ["Coffre 1Password (nom ou identifiant, facultatif)", "1Password vault (name or ID, optional)"], "vault.search_filter": ["Filtre Bitwarden (facultatif)", "Bitwarden filter (optional)"], "vault.session": ["Clé de session obtenue avec bw unlock", "Session key from bw unlock"], "vault.browse": ["Parcourir / actualiser", "Browse / refresh"], "vault.unlock": ["Déverrouiller", "Unlock"], "vault.lock": ["Verrouiller", "Lock"], "vault.remove": ["Retirer le coffre", "Remove vault"], "vault.confirm_remove": ["Retirer ce coffre et ses raccourcis de Cyberdog ? Les données du coffre resteront intactes.", "Remove this vault and its Cyberdog shortcuts? Vault data will remain untouched."], "vault.add_server": ["Ajouter à la liste", "Add to server list"], "vault.edit_server": ["Modifier le raccourci", "Edit shortcut"], "vault.pinned": ["Serveur ajouté. Les identifiants seront lus depuis le coffre à chaque connexion.", "Server added. Credentials will be read from the vault on each connection."], "vault.unpin": ["Retirer le raccourci", "Remove shortcut"], "vault.confirm_unpin": ["Retirer uniquement ce raccourci de Cyberdog ?", "Remove only this Cyberdog shortcut?"], "vault.search": ["Rechercher une entrée…", "Search entries…"], "vault.empty": ["Aucune entrée trouvée dans ce périmètre.", "No entries found in this scope."], "vault.none": ["Ajoutez un coffre, puis sélectionnez les serveurs à afficher.", "Add a vault, then select the servers to display."], "vault.working": ["Communication avec le coffre… Une autorisation peut être demandée par son application.", "Contacting vault… Its application may request authorization."], "vault.intro": ["Vos coffres restent sur cet ordinateur. Seuls les raccourcis sélectionnés apparaissent dans la liste ; les secrets sont lus à chaque connexion, sans partage sur Supabase ni inclusion dans les exports.", "Vault connections stay on this computer. Only selected shortcuts appear in the list; secrets are read on each connection, never shared on Supabase or included in exports."], "vault.setup": ["1Password : installez op et activez son intégration dans l’application 1Password. Bitwarden / Vaultwarden : configurez bw, connectez-vous puis utilisez bw unlock ; la session reste en mémoire pour ce lancement uniquement. Vault : utilisez un jeton limité aux droits read sur data et list sur metadata du dossier choisi.", "1Password: install op and enable its integration in the 1Password app. Bitwarden / Vaultwarden: configure bw, sign in, then use bw unlock; its session stays in memory for this launch only. Vault: use a token limited to read on data and list on metadata for the selected folder."], "vault.mapping": ["Correspondance des champs", "Field mapping"], "vault.field.host": ["Champ hôte (par défaut : host, hostname…)", "Host field (default: host, hostname…)"], "vault.field.user": ["Champ utilisateur (par défaut : username, user…)", "Username field (default: username, user…)"], "vault.field.port": ["Champ port (par défaut : port ou 22)", "Port field (default: port or 22)"], "vault.field.password": ["Champ mot de passe (par défaut : password, pass)", "Password field (default: password, pass)"], "vault.field.privateKey": ["Champ clé privée (par défaut : private_key)", "Private key field (default: private_key)"], "vault.field.passphrase": ["Champ phrase secrète (par défaut : passphrase)", "Passphrase field (default: passphrase)"], "vault.invalid": ["Paramètres du coffre ou du serveur invalides.", "Invalid vault or server parameters."], "vault.url_error": ["Utilisez une adresse HTTPS valide, sans identifiants ni paramètres.", "Use a valid HTTPS address without credentials or query parameters."], "vault.cli": ["CLI introuvable. Installez op, bw ou aws, ou indiquez le chemin de son exécutable natif.", "CLI not found. Install op, bw or aws, or enter its native executable path."], "vault.cli_failed": ["Le CLI a échoué ou l’autorisation a expiré. Vérifiez sa connexion, son déverrouillage et ses permissions, puis réessayez.", "CLI failed or authorization timed out. Check its sign-in, unlock state and permissions, then retry."], "vault.response": ["Réponse du coffre non reconnue.", "Unrecognized vault response."], "vault.storage": ["Le stockage chiffré du système est indisponible ou le fichier du coffre ne peut pas être lu.", "System encrypted storage is unavailable or the vault file cannot be read."], "vault.missing": ["Ce coffre ou cette entrée n’est plus disponible.", "This vault or entry is no longer available."], "vault.locked": ["Coffre verrouillé. Déverrouillez-le depuis Coffres de secrets.", "Vault locked. Unlock it from Secret vaults."], "vault.network": ["Impossible de joindre le coffre. Vérifiez le réseau, le certificat HTTPS et le dossier configuré.", "Cannot reach vault. Check the network, HTTPS certificate and configured folder."], "vault.denied": ["Le coffre refuse cet accès. Vérifiez le jeton et ses droits.", "Vault denied access. Check the token and its permissions."], "vault.limit": ["Le périmètre est trop volumineux. Choisissez un dossier ou un filtre plus précis.", "Scope is too large. Choose a narrower folder or filter."], "vault.no_secret": ["Cette entrée ne contient ni mot de passe ni clé privée. Vérifiez la correspondance des champs.", "This entry contains no password or private key. Check field mapping."], "vault.managed": ["Gérez ce serveur depuis Coffres de secrets.", "Manage this server from Secret vaults."], "vault.ssh_failed": ["Connexion SSH refusée. Vérifiez les identifiants dans le coffre et la cible du raccourci.", "SSH connection failed. Check credentials in the vault and the shortcut target."], "vault.key_invalid": ["Clé SSH du coffre illisible ou phrase secrète manquante. Vérifiez la correspondance des champs.", "Vault SSH key cannot be read or its passphrase is missing. Check field mapping."]}
  for(const [key,values] of Object.entries(VAULT_TRANSLATIONS))for(const language of Object.keys(D))D[language][key]=values[language==='fr'?0:1]

  const BASTION_TRANSLATIONS={"bastion.network": ["Accès réseau", "Network access"], "bastion.mode": ["Connexion", "Connection"], "bastion.direct": ["Direct", "Direct"], "bastion.via": ["Via un bastion SSH", "Via SSH bastion"], "bastion.select": ["Serveur bastion", "Bastion server"], "bastion.search": ["Rechercher un bastion…", "Search bastions…"], "bastion.choose": ["Choisir un serveur…", "Choose a server…"], "bastion.add": ["Ajouter un serveur bastion", "Add bastion server"], "bastion.missing": ["Bastion absent ou incompatible", "Missing or incompatible bastion"], "bastion.this_device": ["Ce poste", "This device"], "bastion.security": ["Sécurité du bastion", "Bastion security"], "bastion.test": ["Tester le trajet via le bastion", "Test the route through the bastion"], "bastion.network_note": ["Le nom de la cible est résolu depuis le bastion. La route est partagée, jamais vos secrets.", "The target name is resolved from the bastion. Routes are shared; your secrets are not."], "bastion.direct_note": ["Connexion directe depuis cet ordinateur. Les options de sécurité et de test du bastion ne s’appliquent pas.", "Direct connection from this computer. Bastion security and test options do not apply."], "bastion.security_note": ["Ces règles concernent les connexions via le bastion et leur serveur cible.", "These rules apply to the bastion connection and its target server."], "bastion.trust_note": ["Vérifiez l’empreinte du bastion et celle de la cible auprès d’une source indépendante. Une empreinte modifiée bloque la connexion.", "Check the bastion and target fingerprints with an independent source. A changed fingerprint blocks the connection."], "bastion.auth_note": ["Chaque serveur a ses propres identifiants. Vos clés restent sur le poste ; aucun transfert d’agent.", "Each server uses its own credentials. Keys stay on this computer; agent forwarding is disabled."], "bastion.mfa_note": ["Les réponses MFA sont utilisées pour la tentative en cours uniquement, sans sauvegarde ni journalisation.", "MFA responses are used only for the current attempt, without persistence or logging."], "bastion.no_fallback": ["Aucun repli vers une connexion directe lorsque le bastion échoue.", "No fallback to a direct connection if the bastion fails."], "bastion.test_run": ["Lancer le test du bastion", "Start bastion test"], "bastion.test_note": ["Teste les données saisies, sans enregistrer la fiche : authentification du bastion, accès à la cible et SFTP. L’acceptation d’une empreinte enregistre votre confiance localement.", "Tests entered settings without saving the server: bastion authentication, target connectivity and SFTP. Accepting a fingerprint stores your trust locally."], "bastion.test_success": ["Trajet via le bastion et SFTP vérifiés. La fiche n’a pas été enregistrée.", "Bastion route and SFTP verified. The server configuration was not saved."], "bastion.bastion": ["Bastion", "Bastion"], "bastion.target": ["Serveur cible", "Target server"], "bastion.trust_title": ["Vérifier l’identité SSH du trajet", "Verify route SSH identity"], "bastion.auth_title": ["Authentification du trajet via bastion", "Bastion route authentication"], "bastion.trust_accept": ["Accepter cette empreinte", "Accept this fingerprint"], "bastion.continue": ["Continuer", "Continue"], "bastion.expires": ["Cette demande expire après deux minutes. Échap annule la tentative.", "This request expires after two minutes. Escape cancels the attempt."], "bastion.passphrase": ["Phrase secrète de la clé SSH", "SSH key passphrase"], "bastion.phase_validating": ["Vérification de la route et des droits…", "Checking route and permissions…"], "bastion.phase_connecting": ["Connexion SSH…", "Connecting SSH…"], "bastion.phase_authenticated": ["Authentification réussie", "Authenticated"], "bastion.phase_opening_channel": ["Ouverture du canal vers la cible…", "Opening target channel…"], "bastion.phase_checking_sftp": ["Vérification du sous-système SFTP…", "Checking SFTP subsystem…"], "bastion.phase_ready": ["Connexion prête", "Connection ready"], "bastion.phase_failed": ["Échec de la connexion", "Connection failed"], "bastion.phase_closed": ["Connexion fermée", "Connection closed"], "bastion.phase_cancelled": ["Tentative annulée", "Attempt cancelled"], "bastion.invalid_route": ["Configuration du bastion invalide.", "Invalid bastion configuration."], "bastion.invalid_server": ["Vérifiez l’adresse, le port et l’utilisateur SSH.", "Check the address, port and SSH user."], "bastion.scope": ["Le bastion doit appartenir au même espace que la cible.", "The bastion must belong to the same workspace as the target."], "bastion.chain": ["Un seul saut est pris en charge. Cette route créerait une chaîne ou une boucle.", "Only one hop is supported. This route would create a chain or cycle."], "bastion.in_use": ["Ce serveur est utilisé comme bastion. Modifiez ses dépendances avant de le déplacer ou supprimer.", "This server is used as a bastion. Update its dependencies before moving or deleting it."], "bastion.cancelled": ["Tentative via bastion annulée.", "Bastion attempt cancelled."], "bastion.prompt_expired": ["La demande d’authentification a expiré. Relancez la connexion.", "The authentication prompt expired. Reconnect to try again."], "bastion.invalid_response": ["Réponse d’authentification invalide.", "Invalid authentication response."], "bastion.expired_challenge": ["Cette demande a expiré ou a déjà été traitée.", "This request expired or was already answered."], "bastion.invalid_key": ["La clé SSH ou sa phrase secrète est invalide.", "Invalid SSH key or passphrase."], "bastion.timeout": ["Le délai de connexion via le bastion est dépassé.", "Bastion connection timed out."], "bastion.authentication_failed": ["Authentification SSH refusée sur le trajet du bastion.", "SSH authentication denied on the bastion route."], "bastion.connection_failed": ["Connexion SSH impossible sur le trajet du bastion.", "SSH connection failed on the bastion route."], "bastion.connection_closed": ["Connexion interrompue sur le trajet du bastion.", "Connection interrupted on the bastion route."], "bastion.connection_lost": ["Le trajet du bastion a été interrompu.", "The bastion route was interrupted."], "bastion.hostkey_changed": ["Empreinte SSH modifiée : connexion via bastion bloquée. Faites vérifier l’identité du serveur.", "Changed SSH fingerprint: bastion connection blocked. Verify the server identity independently."], "bastion.invalid_attempt": ["Tentative de connexion invalide.", "Invalid connection attempt."], "bastion.authorization_expired": ["L’autorisation du trajet a expiré. Connexion fermée.", "Route authorization expired. Connection closed."], "bastion.route_changed": ["La configuration du trajet a changé. Reconnectez-vous.", "The route configuration changed. Reconnect."], "bastion.access_denied": ["Accès au bastion ou à la cible indisponible.", "Bastion or target access unavailable."], "bastion.channel_refused": ["Canal vers la cible refusé. Vérifiez DNS, réseau, AllowTcpForwarding et PermitOpen côté bastion.", "Target channel refused. Check DNS, networking, AllowTcpForwarding and PermitOpen on the bastion."], "bastion.sftp_unavailable": ["La connexion SSH fonctionne, mais le sous-système SFTP est indisponible.", "SSH connected, but the SFTP subsystem is unavailable."], "bastion.test_complete": ["Test terminé, connexions temporaires fermées.", "Test completed, temporary connections closed."]}
  for(const [key,value]of Object.entries(BASTION_TRANSLATIONS))for(const language of Object.keys(D))D[language][key]=value[language==='fr'?0:1]

 for(const [key,pair]of Object.entries({'bastion.export_dependency':['Le ZIP doit inclure le bastion. Un raccourci de coffre reste local et ne peut pas être exporté comme dépendance.','The ZIP must include the bastion. A vault shortcut stays local and cannot be exported as a dependency.'],'bastion.import_conflict':['Un serveur existant utilise un autre trajet. Importez dans un espace sans doublon ou modifiez sa route explicitement.','An existing server uses a different route. Import without duplicate endpoints or edit its route explicitly.'],'bastion.route_unsupported':['Cette version ne peut pas ouvrir ou modifier ce trajet partagé.','This version cannot open or modify this shared route.']}))for(const language of Object.keys(D))D[language][key]=pair[language==='fr'?0:1]

 for(const [key,pair]of Object.entries({'bastion.reset_trust':['Réinitialiser la confiance locale du trajet','Reset local route trust'],'bastion.reset_confirm':['Après vérification indépendante, saisissez l’adresse exacte de la cible. Les connexions du trajet seront fermées. Les empreintes devront être approuvées à nouveau.','After independent verification, enter the exact target address. Route connections will close and fingerprints must be approved again.'],'bastion.reset_done':['Confiance locale réinitialisée. Vérifiez les empreintes à la prochaine connexion.','Local trust reset. Verify fingerprints on the next connection.']}))for(const language of Object.keys(D))D[language][key]=pair[language==='fr'?0:1]

 for(const [key,pair]of Object.entries({'bastion.password':['Mot de passe SSH','SSH password'],'bastion.password_note':['Mot de passe demandé pour ce serveur du trajet. Il sera utilisé uniquement en mémoire pour cette connexion.','Password required for this server in the route. It will be used in memory for this connection only.']}))for(const language of Object.keys(D))D[language][key]=pair[language==='fr'?0:1]

 for(const language of Object.keys(D))D[language]['bastion.via_short']=language==='fr'?'via':'via'

  const ACCOUNT_SESSION_TRANSLATIONS = {
    "account.connect": {"fr": "Connexion", "en": "Sign in", "de": "Anmelden", "it": "Accedi"},
    "account.button": {"fr": "Compte", "en": "Account", "de": "Konto", "it": "Account"},
    "account.password": {"fr": "Mot de passe", "en": "Password", "de": "Passwort", "it": "Password"},
    "account.password_new": {"fr": "Mot de passe (8 caractères minimum)", "en": "Password (8 characters minimum)", "de": "Passwort (mindestens 8 Zeichen)", "it": "Password (minimo 8 caratteri)"},
    "account.intro": {"fr": "Connectez-vous pour créer des équipes et partager des serveurs. Cyberdog reste utilisable sans compte.", "en": "Sign in to create teams and share servers. Cyberdog stays fully usable without an account.", "de": "Melden Sie sich an, um Teams zu erstellen und Server zu teilen. Cyberdog funktioniert auch ohne Konto.", "it": "Accedi per creare team e condividere server. Cyberdog resta utilizzabile senza account."},
    "account.privacy": {"fr": "Mots de passe SSH et clés privées restent sur cet ordinateur, sauf si vous choisissez de les synchroniser pour un serveur partagé.", "en": "SSH passwords and private keys stay on this computer unless you choose to sync them for a shared server.", "de": "SSH-Passwörter und private Schlüssel bleiben auf diesem Computer, außer Sie synchronisieren sie für einen geteilten Server.", "it": "Le password SSH e le chiavi private restano su questo computer, salvo sincronizzazione scelta per un server condiviso."},
    "account.signed_in": {"fr": "Connecté", "en": "Signed in", "de": "Angemeldet", "it": "Connesso"},
    "account.sign_in": {"fr": "Se connecter", "en": "Sign in", "de": "Anmelden", "it": "Accedi"},
    "account.sign_up": {"fr": "Créer le compte", "en": "Create account", "de": "Konto erstellen", "it": "Crea account"},
    "account.sign_out": {"fr": "Se déconnecter", "en": "Sign out", "de": "Abmelden", "it": "Esci"},
    "account.no_account": {"fr": "Créer un compte", "en": "Create an account", "de": "Konto erstellen", "it": "Crea un account"},
    "account.have_account": {"fr": "J’ai déjà un compte", "en": "I already have an account", "de": "Ich habe bereits ein Konto", "it": "Ho già un account"},
    "account.password_confirm": {"fr": "Confirmer le mot de passe", "en": "Confirm password", "de": "Passwort bestätigen", "it": "Conferma password"},
    "account.show_password": {"fr": "Afficher le mot de passe", "en": "Show password", "de": "Passwort anzeigen", "it": "Mostra password"},
    "account.hide_password": {"fr": "Masquer le mot de passe", "en": "Hide password", "de": "Passwort verbergen", "it": "Nascondi password"},
    "account.code": {"fr": "Code à 6 chiffres", "en": "6-digit code", "de": "6-stelliger Code", "it": "Codice a 6 cifre"},
    "account.code_signup": {"fr": "Si l’adresse est valide, un code de vérification vient d’être envoyé à :", "en": "If the address is valid, a verification code has just been sent to:", "de": "Falls die Adresse gültig ist, wurde soeben ein Bestätigungscode gesendet an:", "it": "Se l’indirizzo è valido, è stato appena inviato un codice di verifica a:"},
    "account.code_login": {"fr": "Un code de connexion vient d’être envoyé à :", "en": "A sign-in code has just been sent to:", "de": "Ein Anmeldecode wurde soeben gesendet an:", "it": "Un codice di accesso è stato appena inviato a:"},
    "account.code_resent": {"fr": "Un nouveau code a été envoyé.", "en": "A new code has been sent.", "de": "Ein neuer Code wurde gesendet.", "it": "È stato inviato un nuovo codice."},
    "account.verify": {"fr": "Valider", "en": "Verify", "de": "Bestätigen", "it": "Verifica"},
    "account.resend": {"fr": "Renvoyer le code", "en": "Resend code", "de": "Code erneut senden", "it": "Invia di nuovo il codice"},
    "account.err.otp_invalid": {"fr": "Code incorrect ou expiré.", "en": "The code is incorrect or has expired.", "de": "Der Code ist falsch oder abgelaufen.", "it": "Il codice è errato o scaduto."},
    "account.err.otp_expired": {"fr": "Trop d’essais ou code expiré. Demandez un nouveau code.", "en": "Too many attempts or the code expired. Request a new code.", "de": "Zu viele Versuche oder Code abgelaufen. Fordern Sie einen neuen Code an.", "it": "Troppi tentativi o codice scaduto. Richiedi un nuovo codice."},
    "account.err.mfa_required": {"fr": "Un code de vérification est requis.", "en": "A verification code is required.", "de": "Ein Bestätigungscode ist erforderlich.", "it": "È richiesto un codice di verifica."},
    "account.err.password_mismatch": {"fr": "Les deux mots de passe ne correspondent pas.", "en": "The two passwords do not match.", "de": "Die beiden Passwörter stimmen nicht überein.", "it": "Le due password non corrispondono."},
    "account.err.invalid_credentials": {"fr": "E-mail ou mot de passe incorrect.", "en": "Incorrect e-mail or password.", "de": "E-Mail oder Passwort falsch.", "it": "E-mail o password non corretti."},
    "account.err.email_taken": {"fr": "Un compte existe déjà avec cette adresse.", "en": "An account already exists with this address.", "de": "Mit dieser Adresse existiert bereits ein Konto.", "it": "Esiste già un account con questo indirizzo."},
    "account.err.weak_password": {"fr": "Mot de passe trop court ou trop faible (8 caractères minimum).", "en": "Password too short or too weak (8 characters minimum).", "de": "Passwort zu kurz oder zu schwach (mindestens 8 Zeichen).", "it": "Password troppo corta o debole (minimo 8 caratteri)."},
    "account.err.invalid_email": {"fr": "Adresse e-mail invalide.", "en": "Invalid e-mail address.", "de": "Ungültige E-Mail-Adresse.", "it": "Indirizzo e-mail non valido."},
    "account.err.email_not_confirmed": {"fr": "Adresse e-mail non confirmée.", "en": "E-mail address not confirmed.", "de": "E-Mail-Adresse nicht bestätigt.", "it": "Indirizzo e-mail non confermato."},
    "account.err.signup_disabled": {"fr": "La création de compte est désactivée.", "en": "Account creation is disabled.", "de": "Die Kontoerstellung ist deaktiviert.", "it": "La creazione di account è disattivata."},
    "account.err.network": {"fr": "Service injoignable. Vérifiez la connexion et réessayez.", "en": "Service unreachable. Check the connection and retry.", "de": "Dienst nicht erreichbar. Verbindung prüfen und erneut versuchen.", "it": "Servizio non raggiungibile. Controlla la connessione e riprova."},
    "account.err.rate_limited": {"fr": "Trop de tentatives. Réessayez dans un instant.", "en": "Too many attempts. Please retry shortly.", "de": "Zu viele Versuche. Bitte gleich erneut versuchen.", "it": "Troppi tentativi. Riprova tra poco."},
    "account.err.secure_storage_unavailable": {"fr": "Le stockage sécurisé du système est indisponible.", "en": "Secure system storage is unavailable.", "de": "Der sichere Systemspeicher ist nicht verfügbar.", "it": "L’archivio sicuro del sistema non è disponibile."},
    "account.err.unconfigured": {"fr": "Le service de comptes n’est pas configuré.", "en": "The account service is not configured.", "de": "Der Kontodienst ist nicht konfiguriert.", "it": "Il servizio account non è configurato."},
    "account.err.unknown": {"fr": "Opération impossible. Réessayez.", "en": "The operation failed. Please retry.", "de": "Vorgang fehlgeschlagen. Bitte erneut versuchen.", "it": "Operazione non riuscita. Riprova."},
    "team.join": {"fr": "Rejoindre avec un lien", "en": "Join with a link", "de": "Mit Link beitreten", "it": "Unisciti con un link"},
    "team.join_ok": {"fr": "Rejoindre", "en": "Join", "de": "Beitreten", "it": "Unisciti"},
    "team.joined": {"fr": "Vous avez rejoint l’équipe.", "en": "You joined the team.", "de": "Sie sind dem Team beigetreten.", "it": "Hai aderito al team."},
    "team.link_label": {"fr": "Lien d’invitation", "en": "Invitation link", "de": "Einladungslink", "it": "Link di invito"},
    "team.join_signin": {"fr": "Connectez-vous pour rejoindre une équipe.", "en": "Sign in to join a team.", "de": "Melden Sie sich an, um einem Team beizutreten.", "it": "Accedi per unirti a un team."},
    "team.invite_link": {"fr": "Lien d’invitation", "en": "Invitation link", "de": "Einladungslink", "it": "Link di invito"},
    "team.link_uses": {"fr": "Nombre de personnes pouvant l’utiliser (1 à 50)", "en": "How many people can use it (1–50)", "de": "Wie viele Personen ihn nutzen können (1–50)", "it": "Quante persone possono usarlo (1–50)"},
    "team.link_copied": {"fr": "Lien copié dans le presse-papiers.", "en": "Link copied to the clipboard.", "de": "Link in die Zwischenablage kopiert.", "it": "Link copiato negli appunti."},
    "team.link_ready": {"fr": "Envoyez ce lien à la personne invitée. Il n’est affiché qu’une seule fois.", "en": "Send this link to the invited person. It is only shown once.", "de": "Senden Sie diesen Link an die eingeladene Person. Er wird nur einmal angezeigt.", "it": "Invia questo link alla persona invitata. Viene mostrato una sola volta."},
    "team.link_pending": {"fr": "Lien d’invitation actif · {n} utilisation(s) restante(s)", "en": "Active invitation link · {n} use(s) left", "de": "Aktiver Einladungslink · {n} Nutzung(en) übrig", "it": "Link di invito attivo · {n} utilizzi rimasti"},
    "team.invite_note": {"fr": "Les liens expirent après 7 jours. Ne les partagez qu’avec les personnes concernées ; vous pouvez les annuler à tout moment.", "en": "Links expire after 7 days. Share them only with the people concerned; you can cancel them at any time.", "de": "Links laufen nach 7 Tagen ab. Teilen Sie sie nur mit den Betroffenen; Sie können sie jederzeit widerrufen.", "it": "I link scadono dopo 7 giorni. Condividili solo con le persone interessate; puoi annullarli in qualsiasi momento."},
    "team.invite_unavailable": {"fr": "Ce lien d’invitation est invalide, expiré ou déjà utilisé.", "en": "This invitation link is invalid, expired or already used.", "de": "Dieser Einladungslink ist ungültig, abgelaufen oder bereits verwendet.", "it": "Questo link di invito non è valido, è scaduto o è già stato usato."},
    "team.already_member": {"fr": "Vous faites déjà partie de cette équipe.", "en": "You are already a member of this team.", "de": "Sie sind bereits Mitglied dieses Teams.", "it": "Fai già parte di questo team."},
    "team.invite_limit": {"fr": "Trop de liens actifs pour cette équipe.", "en": "Too many active links for this team.", "de": "Zu viele aktive Links für dieses Team.", "it": "Troppi link attivi per questo team."},
  }
  for (const [key, values] of Object.entries(ACCOUNT_SESSION_TRANSLATIONS)) for (const language of Object.keys(D)) D[language][key] = values[language] || values.en

}
if(typeof module!=='undefined')module.exports={apply:applyWorkspaceTranslations};else if(typeof i18n!=='undefined')applyWorkspaceTranslations(i18n.D)
