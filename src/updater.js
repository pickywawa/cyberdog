// Self-update for the GitHub editions (Windows installer through electron-updater, DMG/AppImage/ZIP otherwise).
// The Mac App Store edition ships build/mas/stubs/src/updater.js instead: updates come from the App Store.
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { autoUpdater } = require('electron-updater')
const { isNewerVersion, selectUpdateAsset, openUpdatePackage } = require('./update-version')

module.exports = function createUpdater({ app, ipcMain, net, shell, dialog, send, t, getWindow, getSettings, isWin }) {
  let releaseUrl
  let updateVersion
  let updateMode = 'manual'
  let updateReady = false
  let updateDownloadStarted = false
  let installAfterDownload = false
  let updateCheckPromise
  let updateNotes = ''
  let updateReleaseName = ''
  let updateAsset
  let updateFile
  let updatePercent = 0
  let lastUpdateState = 'current'
  let updateOpenPromise

  function openDownloadedUpdate() {
    installAfterDownload = false
    if (updateOpenPromise) return updateOpenPromise
    updateOpenPromise = openUpdatePackage({ platform: process.platform, file: updateFile, version: updateVersion, dialog, shell, app, window: getWindow(), t })
      .finally(() => { updateOpenPromise = null })
    return updateOpenPromise
  }

  const updateStatus = (state, extra = {}) => ({
    state,
    mode: updateMode,
    version: updateVersion,
    name: updateReleaseName,
    notes: updateNotes,
    url: releaseUrl,
    percent: updatePercent,
    ...extra,
  })
  const sendUpdate = (state, extra) => {
    lastUpdateState = state
    send('app:update', updateStatus(state, extra))
  }
  ipcMain.handle('app:update:status', () => updateStatus(lastUpdateState))

  function useManualUpdate(error) {
    if (error) console.error('Cyberdog update failed; opening the release page instead:', error)
    updateMode = 'manual'
    updateDownloadStarted = false
    installAfterDownload = false
    sendUpdate('available')
  }

  async function downloadReleaseAsset(openFallback = true) {
    if (!updateAsset) {
      if (openFallback) return shell.openExternal(releaseUrl)
      throw new Error('The release does not contain a compatible update package.')
    }
    updateDownloadStarted = true
    updatePercent = 0
    sendUpdate('downloading')
    const target = path.join(app.getPath('downloads'), updateAsset.name)
    const temporary = target + '.download'
    try {
      // Chromium networking follows the system proxy, including enterprise PAC/WPAD.
      const response = await net.fetch(updateAsset.url, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'Cyberdog' },
        signal: AbortSignal.timeout(30 * 60 * 1000),
      })
      if (!response.ok || !response.body) throw new Error(`GitHub returned HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || 0
      const output = fs.openSync(temporary, 'w', 0o600)
      const hash = crypto.createHash('sha256')
      const reader = response.body.getReader()
      let received = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hash.update(value)
          received += value.length
          fs.writeSync(output, value)
          updatePercent = total ? Math.floor(received * 100 / total) : 0
          sendUpdate('downloading')
        }
      } finally {
        fs.closeSync(output)
      }
      if (updateAsset.digest && hash.digest('hex') !== updateAsset.digest) throw new Error('The downloaded update checksum is invalid.')
      fs.rmSync(target, { force: true })
      fs.renameSync(temporary, target)
      updateFile = target
      updateReady = true
      updateDownloadStarted = false
      updatePercent = 100
      sendUpdate('ready')
    } catch (error) {
      fs.rmSync(temporary, { force: true })
      updateDownloadStarted = false
      updatePercent = 0
      useManualUpdate(error)
      throw error
    }
    if (installAfterDownload) await openDownloadedUpdate()
  }

  async function performUpdateAction(install) {
    if (!releaseUrl || !updateVersion) throw new Error('No Cyberdog update is available.')
    installAfterDownload = install
    if (updateMode !== 'install') {
      if (updateReady && updateFile) return install ? openDownloadedUpdate() : undefined
      if (updateDownloadStarted) return
      return downloadReleaseAsset()
    }
    try { await updateCheckPromise } catch (e) { useManualUpdate(e); return shell.openExternal(releaseUrl) }
    if (updateMode !== 'install') return shell.openExternal(releaseUrl)
    if (updateReady) return install ? autoUpdater.quitAndInstall() : undefined
    if (updateDownloadStarted) return
    updateDownloadStarted = true
    sendUpdate('downloading', { percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e) {
      useManualUpdate(e)
      return shell.openExternal(releaseUrl)
    }
  }
  ipcMain.handle('app:update:action', () => performUpdateAction(true))
  ipcMain.handle('app:update:download', () => performUpdateAction(false))

  async function checkForAppUpdate() {
    if (!app.isPackaged) return
    try {
      const response = await net.fetch('https://api.github.com/repos/pickywawa/cyberdog/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cyberdog' },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`)
      const release = await response.json()
      if (!isNewerVersion(release.tag_name, app.getVersion())) {
        updateVersion = undefined
        updateNotes = ''
        updateReleaseName = ''
        releaseUrl = undefined
        updateAsset = undefined
        updateFile = undefined
        updateReady = false
        updateDownloadStarted = false
        updatePercent = 0
        sendUpdate('current')
        return
      }
      updateVersion = String(release.tag_name).replace(/^v/, '')
      updateReleaseName = String(release.name || release.tag_name)
      updateNotes = String(release.body || '').trim().slice(0, 12000)
      releaseUrl = /^https:\/\/github\.com\/pickywawa\/cyberdog\/releases\//.test(release.html_url)
        ? release.html_url
        : 'https://github.com/pickywawa/cyberdog/releases/latest'
      updateMode = isWin && !process.env.PORTABLE_EXECUTABLE_DIR ? 'install' : 'manual'
      updateAsset = selectUpdateAsset(release, process.platform, process.arch, updateVersion)

      if (updateMode === 'install') {
        let result
        try {
          updateCheckPromise = autoUpdater.checkForUpdates()
          result = await updateCheckPromise
        } catch (e) {
          return useManualUpdate(e)
        }
        if (!result?.isUpdateAvailable) return useManualUpdate(new Error('No compatible Windows installer was found.'))
      }
      if (getSettings().autoDownload) {
        if (updateMode === 'manual') downloadReleaseAsset(false).catch(error => console.error('Unable to download Cyberdog update:', error))
      } else sendUpdate(updateDownloadStarted ? 'downloading' : 'available')
    } catch (e) {
      console.error('Unable to check for Cyberdog updates:', e)
      sendUpdate('error')
    }
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-available', info => {
    updateVersion = info.version
    if (getSettings().autoDownload && updateMode === 'install') updateDownloadStarted = true
    sendUpdate(updateDownloadStarted ? 'downloading' : 'available')
  })
  autoUpdater.on('download-progress', progress => {
    updateDownloadStarted = true
    updatePercent = Math.floor(progress.percent)
    sendUpdate('downloading')
  })
  autoUpdater.on('update-downloaded', info => {
    updateReady = true
    updateDownloadStarted = false
    updatePercent = 100
    sendUpdate('ready', { version: info.version })
    if (installAfterDownload) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('update-not-available', () => {
    if (updateMode === 'install' && updateVersion) useManualUpdate(new Error('The release does not contain a compatible update package.'))
  })

  return {
    setAutoDownload(value) { autoUpdater.autoDownload = !!value },
    check: checkForAppUpdate,
  }
}
