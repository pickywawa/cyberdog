// Mac App Store build configuration (npm run dist:mas), derived from package.json → build.
// electron-builder does not combine the top-level `files` with `mas.files` the way one would expect: as soon as the
// platform adds patterns, the whole project (backend, docs, site, tests…) is packaged. This edition therefore declares
// its complete file list here, and swaps in build/mas/stubs and build/mas/generated (see build/mas-prepare.js) for the
// features that the App Sandbox does not allow.
const base = require('../package.json').build

const removed = [
  // self-update: the App Store delivers updates
  'src/updater.js', 'src/update-version.js', '**/node_modules/electron-updater/**',
  // SMB (mount_smbfs) and OAuth cloud drives (local loopback listener)
  'src/smb-storage.js', 'src/cloud-drives.js', 'src/oauth.js',
  // Cyberdog account, teams and shared servers
  'src/workspace/cloud-account.js', 'src/workspace/config.json', 'src/workspace/ui/account-ui.js', 'src/workspace/ui/shared-ui.js',
  // secret-manager integrations (external command-line tools)
  'src/workspace/secret-vaults.js', 'src/workspace/enterprise-vaults.js', 'src/workspace/rdm-reader.ps1',
  'src/workspace/assets/vaults/**', 'src/workspace/ui/vault-ui.js',
  // replaced by generated copies without the texts of the features above
  'src/i18n.js', 'src/locales/**', 'src/workspace/i18n.js', 'src/index.html',
]

module.exports = {
  ...base,
  publish: null,
  // team invitation links (cyberdog://): no account in this edition
  protocols: [],
  files: [
    {
      filter: [
        ...base.files,
        ...base.mas.files,
        ...removed.map(pattern => '!' + pattern),
      ],
    },
    { from: 'build/mas/stubs', to: '.', filter: ['**/*'] },
    { from: 'build/mas/generated', to: '.', filter: ['**/*'] },
  ],
  mas: { ...base.mas, files: undefined },
}
