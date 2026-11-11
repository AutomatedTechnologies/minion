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
 *    see terminal-skin.css. The academy2 sheet is whitelist-built
 *    (the academy1 sheet failed on the real hosted UI — owner
 *    screenshot 2026-11-10 17:08 EST, files/19), and the persisted
 *    preference is epoch-gated (SKIN_EPOCH): a state file written
 *    before the current epoch loads with the skin OFF, so an
 *    upgrade can never re-apply a superseded skin unasked, and a
 *    fresh install defaults OFF. Only an explicit toggle in a
 *    build of the current epoch persists ON.
 *  - Markdown routing (0.4.0-academy3, Distro files/24): the
 *    owner's preference for where a downloaded markdown file
 *    opens — MacDown (default), Ask Each Time, or the system
 *    default — persisted here as markdownRoute and read by the
 *    main-process router (md-route.cjs) at each download
 *    completion. State only; the routing itself is the shell's.
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
const { MACDOWN_BUNDLE_ID } = require('./md-route.cjs');

const STATE_FILE = 'academy-state.json';

// Terminal-skin preference epoch. Epoch 2 = the whitelist-rebuilt
// sheet (0.4.0-academy2). A persisted skin preference is honored
// only when the state file carries the CURRENT epoch; anything
// older (including every academy1 state file, which has no epoch)
// loads with the skin OFF and must be re-enabled by hand. Bump
// this whenever the sheet's discipline changes materially.
const SKIN_EPOCH = 2;

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
  // Markdown routing preference (files/24 section 5a): where a
  // downloaded .md/.markdown opens. 'macdown' is the default —
  // the owner's directive is the consent for Muse-internal
  // behavior. Finder and every other app are untouched by it.
  let markdownRoute = 'macdown';
  // Consented system default (files/24 section 5b, MD-T3): the
  // handler recorded BEFORE any set this app performs (restored
  // when the owner unchecks the menu item), and the Never Ask
  // suppression for the one-time offer after a first route.
  let markdownDefaultPrevHandler = null;
  let markdownDefaultNeverAsk = false;
  let markdownDefaultOfferedThisSession = false;
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
        // Epoch gate: a pre-epoch (or older-epoch) state file must
        // not resurrect a superseded skin on upgrade — the academy1
        // preference, written while its chaotic sheet was live, is
        // deliberately dropped here; the owner re-enables the skin
        // explicitly if he wants the rebuilt one.
        terminalSkin = data.skinEpoch >= SKIN_EPOCH && data.terminalSkin === true;
        welcomeSeen = data.welcomeSeen === true;
        if (['macdown', 'ask', 'system'].includes(data.markdownRoute)) {
          markdownRoute = data.markdownRoute;
        }
        if (typeof data.markdownDefaultPrevHandler === 'string' &&
            data.markdownDefaultPrevHandler) {
          markdownDefaultPrevHandler = data.markdownDefaultPrevHandler;
        }
        markdownDefaultNeverAsk = data.markdownDefaultNeverAsk === true;
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
        skinEpoch: SKIN_EPOCH,
        welcomeSeen: welcomeSeen,
        markdownRoute: markdownRoute,
        markdownDefaultPrevHandler: markdownDefaultPrevHandler,
        markdownDefaultNeverAsk: markdownDefaultNeverAsk,
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

  function setMarkdownRoute(route) {
    if (!['macdown', 'ask', 'system'].includes(route)) return;
    markdownRoute = route;
    saveState();
  }

  // ---- Consented system default (files/24 section 5b, MD-T3) ----
  // The bundled AcademyLSDefault helper (injected as ctx.lsDefault
  // by main) is the only path to LaunchServices: get / set /
  // restore for net.daringfireball.markdown only. The menu checkbox
  // reads LIVE LS state at menu-build time — never the app's own
  // bookkeeping — so a change made in Finder shows truthfully here.

  function markdownDefaultIsCurrent() {
    try {
      return Boolean(ctx.lsDefault) &&
        ctx.lsDefault.getSync() === MACDOWN_BUNDLE_ID;
    } catch (error) {
      return false;
    }
  }

  async function infoDialog(title, message) {
    const win = BrowserWindow.getFocusedWindow() || undefined;
    const options = { type: 'info', title: title, message: title, detail: message, buttons: ['OK'], defaultId: 0 };
    try {
      if (win) { await dialog.showMessageBox(win, options); }
      else { await dialog.showMessageBox(options); }
    } catch (error) { /* the fact stands without the dialog */ }
  }

  async function setMarkdownDefaultEnabled(enabled) {
    if (!ctx.lsDefault) return;
    if (enabled) {
      const prev = ctx.lsDefault.getSync();
      if (prev === MACDOWN_BUNDLE_ID) { buildMenu(); return; }
      // Record the predecessor BEFORE the set — the restore on
      // uncheck depends on this ordering.
      if (prev) {
        markdownDefaultPrevHandler = prev;
        saveState();
      }
      const ok = await ctx.lsDefault.set();
      if (!ok) {
        await infoDialog(
          'Couldn’t make MacDown the default',
          'LaunchServices did not accept the change. Markdown files you download in Muse still open in MacDown; only the system-wide default is unchanged.');
      }
    } else {
      const prev = markdownDefaultPrevHandler;
      if (prev) {
        const ok = await ctx.lsDefault.restore(prev);
        if (ok) {
          markdownDefaultPrevHandler = null;
          saveState();
        } else {
          await infoDialog(
            'Couldn’t restore the previous default',
            'LaunchServices did not accept the restore. The previous handler is still recorded; try again, or set the default in Finder (Get Info → Open With → Change All…).');
        }
      } else {
        await infoDialog(
          'Choose the default in Finder',
          'This app has no recorded previous default for markdown files, so there is nothing to restore. To pick one: right-click any .md file in Finder, choose Get Info, select an app under “Open with”, then click “Change All…”.');
      }
    }
    buildMenu();
  }

  // The one-time offer, fired by the router after the first
  // successful route of a session (main wires it). Not Now may be
  // offered again on a later session's first route; Never Ask is
  // persisted and ends the offers permanently.
  async function offerMarkdownDefault() {
    if (markdownDefaultOfferedThisSession) return;
    markdownDefaultOfferedThisSession = true;
    if (markdownDefaultNeverAsk) return;
    if (!ctx.lsDefault || !ctx.lsDefault.available()) return;
    if (markdownDefaultIsCurrent()) return;
    const win = BrowserWindow.getFocusedWindow() || undefined;
    const options = {
      type: 'question',
      title: 'Make MacDown the default for markdown files?',
      message: 'Make MacDown the default for markdown files?',
      detail: 'MacDown already opens the markdown files you download in Muse. You can also make it the default app for markdown files everywhere on this Mac, Finder included. This changes only markdown files — plain text files are not affected. You can undo it any time in the View menu.',
      buttons: ['Make Default', 'Not Now', 'Never Ask'],
      defaultId: 0,
      cancelId: 1,
    };
    let response = 1;
    try {
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      response = result.response;
    } catch (error) {
      return;
    }
    if (response === 0) {
      await setMarkdownDefaultEnabled(true);
    } else if (response === 2) {
      markdownDefaultNeverAsk = true;
      saveState();
    }
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
            label: 'Markdown Files Open In',
            submenu: [
              {
                label: 'MacDown',
                type: 'radio',
                checked: markdownRoute === 'macdown',
                click: () => setMarkdownRoute('macdown'),
              },
              {
                label: 'Ask Each Time',
                type: 'radio',
                checked: markdownRoute === 'ask',
                click: () => setMarkdownRoute('ask'),
              },
              {
                label: 'System Default',
                type: 'radio',
                checked: markdownRoute === 'system',
                click: () => setMarkdownRoute('system'),
              },
            ],
          },
          { type: 'separator' },
          {
            label: 'Also Make MacDown the Default for Markdown Files',
            type: 'checkbox',
            checked: markdownDefaultIsCurrent(),
            enabled: Boolean(ctx.lsDefault),
            click: (item) => { void setMarkdownDefaultEnabled(item.checked); },
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
    applicationVersion: ctx.buildLabel || '0.4.0-academy3',
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
    getMarkdownRoute: () => markdownRoute,
    setMarkdownRoute: setMarkdownRoute,
    offerMarkdownDefault: offerMarkdownDefault,
    setMarkdownDefaultEnabled: setMarkdownDefaultEnabled,
    getMarkdownDefaultState: () => ({
      prevHandler: markdownDefaultPrevHandler,
      neverAsk: markdownDefaultNeverAsk,
      isCurrent: markdownDefaultIsCurrent(),
    }),
    getWindowState: () => windowState,
    setWindowState: (bounds, isMaximized) => {
      windowState = { bounds: bounds || null, isMaximized: !!isMaximized };
      saveState();
    },
  };
}

module.exports = { earlyInit: earlyInit, install: install };
