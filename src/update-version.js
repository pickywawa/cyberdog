function isNewerVersion(latest, current) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value))
    return match ? match.slice(1).map(Number) : null
  }
  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

function selectUpdateAsset(release, platform, arch, version) {
  const name = platform === 'darwin'
    ? `Cyberdog-${version}-mac-${arch}.dmg`
    : `Cyberdog-${version}-portable-x64.exe`
  const asset = Array.isArray(release.assets) && release.assets.find(item => item.name === name)
  if (!asset || !/^https:\/\/github\.com\/pickywawa\/cyberdog\/releases\/download\//.test(asset.browser_download_url)) return undefined
  return {
    name,
    url: asset.browser_download_url,
    digest: String(asset.digest || '').startsWith('sha256:') ? String(asset.digest).slice(7) : '',
  }
}

module.exports = { isNewerVersion, selectUpdateAsset }
