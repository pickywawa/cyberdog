const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...a) =>
    ipcRenderer.invoke(ch, ...a).catch(e => {
      throw new Error(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }),
  send: (ch, ...a) => ipcRenderer.send(ch, ...a),
  on: (ch, fn) => {const listener=(_, ...a)=>fn(...a);ipcRenderer.on(ch,listener);return()=>ipcRenderer.removeListener(ch,listener)},
  pathOf: f => webUtils.getPathForFile(f),
  platform: process.platform,
  premiumAvailable:process.argv.includes('--cyberdog-premium'),
})
