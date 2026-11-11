'use strict';
/*
 * welcome-preload.cjs — Minion 0.4.1.
 * The whole bridge for the SDS-8 welcome window: one signal, the
 * owner's Continue. Nothing else is exposed to the welcome page.
 */
try {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('academyWelcome', {
    done: function () {
      ipcRenderer.send('academy:welcome:done');
    },
    // SDS-10 clause 2: the startup screen's version comes from the
    // bundle's own Info.plist at runtime (main answers with
    // app.getVersion()), never from a string baked into the page.
    getBuildInfo: function () {
      return ipcRenderer.sendSync('academy:build-info');
    },
  });
} catch (error) {
  // welcome.html carries a window.close() fallback.
}
