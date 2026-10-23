// macOS : signature ad hoc ("-") du .app avant la création du .dmg.
// Sans certificat Apple, une app arm64 téléchargée (quarantaine) serait annoncée « endommagée » ;
// avec la signature ad hoc, macOS propose simplement « Ouvrir quand même ».
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async ctx => {
  if (ctx.electronPlatformName !== 'darwin') return
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
