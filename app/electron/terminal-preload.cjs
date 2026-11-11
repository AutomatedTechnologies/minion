'use strict';
/*
 * terminal-preload.cjs — Minion 0.4.1.
 * The whole bridge for the shell's Terminal window (terminal.html):
 * send a message to the hosted session, read back the shared
 * history, ask for the build identity, jump back to the hosted
 * view, and receive stream events (state / delta / done) from the
 * main process. Nothing else is exposed to the terminal page.
 */
try {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('academyTerminal', {
    send: function (text) {
      return ipcRenderer.invoke('academy:terminal:send', text);
    },
    history: function () {
      return ipcRenderer.invoke('academy:terminal:history');
    },
    info: function () {
      return ipcRenderer.invoke('academy:terminal:info');
    },
    showHosted: function () {
      ipcRenderer.send('academy:terminal:show-hosted');
    },
    onEvent: function (callback) {
      ipcRenderer.on('academy:terminal:event', function (_event, payload) {
        try {
          callback(payload);
        } catch (error) { /* the page guards itself too */ }
      });
    },
  });
} catch (error) {
  // terminal.html prints a bridge-missing line when the API is
  // absent; the window itself still opens and /view still works
  // from the View menu's side (the hosted window is separate).
}
