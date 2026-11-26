// Mac App Store edition: updates are delivered by the App Store, so the app contains no updater.
module.exports = function createUpdater({ ipcMain }) {
  ipcMain.handle('app:update:status', () => ({ state: 'current' }))
  return { setAutoDownload() {}, check() {} }
}
