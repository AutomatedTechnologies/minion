'use strict';
/*
 * academy.cjs — Muse (Academy Build) v0.4.0-academy, main process.
 *
 * The Academy feature layer over the upstream muse-desktop shell:
 *  - Sent-message history (history.cjs): persisted per conversation
 *    in the app's own data directory (academy-state.json inside
 *    userData), served to the preload over IPC. IPC is accepted
 *    only from the muse.ai origin (utils.cjs isMuseOrigin).
 *  - Terminal skin: a persisted preference toggled from the View
 *    menu; the stylesheet text is served to the preload, which
 *    gates it on the html.academy-terminal class. SDS monochrome —
 *    see terminal-skin.css.
 *  - SDS-8 welcome: a local welcome window (welcome.html + the
 *    library startup sound) shown once, on first launch; replayable
 *    from the app menu. Never blocks the service window beyond the
 *    owner's Continue / close.
 *  - Application menu: upstream shipped none (Electron's default
 *    menu stood in). This menu keeps the default roles and adds the
 *    Academy items above; the Help menu carries the unofficial-build
 *    line so the provenance is visible in the product itself.
 *
 * Electron 22.3.27 APIs only (macOS 10.13 floor).
 */

const fs = require('node:fs');
const path = require('node:path');
const { createHistoryStore } = require('./history.cjs');
const { isMuseOrigin } = require('./utils.cjs');

const STATE_FILE = 'academy-state.json';

function earlyInit(app) {
  // The SDS-8 startup sound plays from the welcome window without a
  // prior user gesture; without this switch Chromium's autoplay
  // policy would hold it until a click.
  try {
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  } catch (error) {
    console.warn('Could not set autoplay policy');
  }
}

function install(ctx) {
  const { app, BrowserWindow, Menu, dialog, ipcMain } = ctx;
  const statePath = path.join(app.getPath('userData'), STATE_FILE);
  const store = createHistoryStore();
  let terminalSkin = false;
  let welcomeSeen = false;
  // Window-management repair: the main window's normal bounds +
  // maximized flag, persisted so the app reopens where the owner
  // left it — validated against the current displays on restore
  // (window-state.cjs), never trusted blind.
  let windowState = null;

  function loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (data && typeof data === 'object') {
        store.load(data.history);
        terminalSkin = data.terminalSkin === true;
        welcomeSeen = data.welcomeSeen === true;
        if (data.window && typeof data.window === 'object') {
          windowState = {
            bounds: data.window.bounds || null,
            isMaximized: data.window.isMaximized === true,
          };
        }
      }
    } catch (error) {
      // No state yet (first launch) or an unreadable file: defaults.
    }
  }

  function saveState() {
    try {
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        history: store.toJSON(),
        terminalSkin: terminalSkin,
        welcomeSeen: welcomeSeen,
        window: windowState,
      }), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (error) {
      console.warn('Could not save Academy state');
    }
  }
  loadState();

  function senderIsMuse(event) {
    try {
      return isMuseOrigin(event.sender.getURL());
    } catch (error) {
      return false;
    }
  }

  function validKey(key) {
    return typeof key === 'string' && key.length > 0 && key.length <= 300;
  }

  ipcMain.handle('academy:history:list', (event, key) => {
    if (!senderIsMuse(event) || !validKey(key)) return [];
    return store.list(key);
  });

  ipcMain.handle('academy:history:add', (event, key, text) => {
    if (!senderIsMuse(event) || !validKey(key) || typeof text !== 'string') {
      return [];
    }
    const entries = store.add(key, text.slice(0, 20000));
    saveState();
    return entries;
  });

  ipcMain.handle('academy:skin:get', (event) => {
    if (!senderIsMuse(event)) return false;
    return terminalSkin;
  });

  let skinCss = '';
  try {
    skinCss = fs.readFileSync(path.join(__dirname, 'terminal-skin.css'), 'utf8');
  } catch (error) {
    console.warn('Terminal skin stylesheet missing');
  }
  ipcMain.handle('academy:skin:css', (event) => {
    if (!senderIsMuse(event)) return '';
    return skinCss;
  });

  function broadcastSkin() {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('academy:skin:apply', terminalSkin);
      } catch (error) { /* window going away */ }
    }
  }

  let skinMenuItem = null;
  function setTerminalSkin(on) {
    terminalSkin = !!on;
    if (skinMenuItem) skinMenuItem.checked = terminalSkin;
    saveState();
    broadcastSkin();
  }

  // SDS-10 clause 2: the welcome page asks for the build's version;
  // the answer is app.getVersion() — the value Electron reads from
  // this bundle's Info.plist at runtime. Only the welcome window
  // (a local file page) may ask.
  ipcMain.on('academy:build-info', (event) => {
    try {
      const url = event.sender.getURL();
      if (url.startsWith('file:') && url.indexOf('welcome.html') !== -1) {
        event.returnValue = {
          name: 'Muse (Academy Build)',
          version: app.getVersion(),
          build: ctx.buildLabel || '',
        };
        return;
      }
    } catch (error) { /* fall through */ }
    event.returnValue = null;
  });

  // ---- SDS-8 welcome ----
  let welcomeWindow = null;
  function showWelcome(onDone) {
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.focus();
      return welcomeWindow;
    }
    welcomeWindow = new BrowserWindow({
      title: 'Welcome — Muse (Academy Build)',
      width: 680,
      height: 540,
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#0a0a0a',
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'welcome-preload.cjs'),
      },
    });
    let proceeded = false;
    const proceed = (seen) => {
      if (proceeded) return;
      proceeded = true;
      if (seen && !welcomeSeen) {
        welcomeSeen = true;
        saveState();
      }
      if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.close();
      welcomeWindow = null;
      if (typeof onDone === 'function') onDone();
    };
    const onWelcomeDone = (event) => {
      if (welcomeWindow && event.sender === welcomeWindow.webContents) proceed(true);
    };
    ipcMain.on('academy:welcome:done', onWelcomeDone);
    welcomeWindow.on('closed', () => {
      ipcMain.removeListener('academy:welcome:done', onWelcomeDone);
      // Closing the welcome counts as having seen it, and never
      // strands the owner without the service window.
      proceed(true);
    });
    welcomeWindow.once('ready-to-show', () => {
      if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.show();
    });
    void welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'));
    return welcomeWindow;
  }

  function gateWelcome(openServiceWindow) {
    if (welcomeSeen) {
      openServiceWindow();
      return;
    }
    showWelcome(openServiceWindow);
  }

  // ---- Application menu ----
  function buildMenu() {
    const template = [
      {
        label: app.getName(),
        submenu: [
          {
            role: 'about',
            label: 'About Muse (Academy Build)',
          },
          {
            label: 'Welcome Screen…',
            click: () => showWelcome(),
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Terminal Skin',
            type: 'checkbox',
            checked: terminalSkin,
            accelerator: 'CmdOrCtrl+Shift+T',
            click: (item) => setTerminalSkin(item.checked),
          },
          {
            label: 'Clear Saved Message History…',
            click: async () => {
              const win = BrowserWindow.getFocusedWindow() || undefined;
              const { response } = await dialog.showMessageBox(win, {
                type: 'warning',
                message: 'Clear saved message history?',
                detail: 'This deletes the per-conversation up-arrow history stored on this Mac. It cannot be undone.',
                buttons: ['Cancel', 'Clear History'],
                defaultId: 0,
                cancelId: 0,
              });
              if (response === 1) {
                store.clear();
                saveState();
              }
            },
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close' },
          { type: 'separator' },
          { role: 'front' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Unofficial build — not a Meta product',
            enabled: false,
          },
          {
            label: 'Built from muse-desktop (MIT) on Electron 22.3.27',
            enabled: false,
          },
        ],
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    // Keep a handle on the skin checkbox so state loaded later or
    // changed programmatically stays in sync with the menu.
    for (const top of menu.items) {
      if (top.label !== 'View' || !top.submenu) continue;
      for (const item of top.submenu.items) {
        if (item.label === 'Terminal Skin') skinMenuItem = item;
      }
    }
  }
  buildMenu();

  app.setAboutPanelOptions({
    applicationName: 'Muse (Academy Build)',
    applicationVersion: ctx.buildLabel || '0.4.0-academy1',
    version: '0.4.0',
    copyright:
      'Unofficial build: not a Meta product and not endorsed by Meta. ' +
      'muse-desktop is MIT, (c) Benjamin Kitt and Muse Desktop contributors. ' +
      'Academy build by the Detroit Automation Academy.',
  });

  return {
    gateWelcome: gateWelcome,
    showWelcome: () => showWelcome(),
    setTerminalSkin: setTerminalSkin,
    isTerminalSkin: () => terminalSkin,
    getWindowState: () => windowState,
    setWindowState: (bounds, isMaximized) => {
      windowState = { bounds: bounds || null, isMaximized: !!isMaximized };
      saveState();
    },
  };
}

module.exports = { earlyInit: earlyInit, install: install };
