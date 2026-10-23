const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...a) =>
    ipcRenderer.invoke(ch, ...a).catch(e => {
      throw new Error(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }),
  send: (ch, ...a) => ipcRenderer.send(ch, ...a),
  on: (ch, fn) => ipcRenderer.on(ch, (_, ...a) => fn(...a)),
  pathOf: f => webUtils.getPathForFile(f),
  platform: process.platform,
})
