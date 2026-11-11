'use strict';
/*
 * academy.cjs — Minion 0.4.1, main process.
 *
 * The Academy feature layer over the upstream shell:
 *  - Sent-message history (history.cjs): persisted per conversation
 *    in the app's own data directory (academy-state.json inside
 *    userData), served to the preload over IPC. IPC is accepted
 *    only from the API endpoint origin (utils.cjs isEndpointOrigin).
 *  - Terminal view (0.4.0-academy5, Distro files/19 section 10):
 *    a first-class shell window (View menu, CmdOrCtrl+T) running
 *    terminal.html — the shell's own renderer surface, NOT CSS
 *    over the hosted page. It is a front-end over the live hosted
 *    session: a send is driven into the hosted window's composer
 *    through the preload bridge and the reply is observed from the
 *    hosted message stream as it renders. The terminal skin this
 *    replaces was REJECTED by the owner (rig verdict 2026-11-10
 *    18:30 EST: solid black composer bar, no text field) and is
 *    DELETED in this build — the stylesheet file, the View-menu
 *    toggle, the skin IPC channels and the SKIN_EPOCH machinery
 *    are gone, not defaulted-off. Legacy terminalSkin / skinEpoch
 *    keys in a state file are ignored on load and dropped on the
 *    next save (saveState writes a fixed field set).
 *  - Appearance (0.4.0-minion3): the shell's color scheme,
 *    applied through Electron's nativeTheme — the lever that
 *    sets prefers-color-scheme for every webContents. DARK by
 *    default (owner directive 2026-11-10 22:36 EST): on a fresh
 *    profile the app presents dark. The default is a seed, not
 *    a lock — the owner's explicit choice (View menu, Dark /
 *    Light / System) persists as `appearance` in the state file
 *    and is the value applied on every later launch; the dark
 *    default fills only the unset branch. On the 10.13 floor
 *    this lever is decisive: High Sierra has no system dark
 *    mode, so 'system' resolves light there and only an
 *    explicit themeSource makes the hosted UI's dark scheme
 *    reachable at all.
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
const { isEndpointOrigin } = require('./utils.cjs');
const { MACDOWN_BUNDLE_ID } = require('./md-route.cjs');

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
  let welcomeSeen = false;
  // Markdown routing preference (files/24 section 5a): where a
  // downloaded .md/.markdown opens. 'macdown' is the default —
  // the owner's directive is the consent for endpoint-internal
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
  // Appearance (0.4.0-minion3): the owner's explicit color-scheme
  // choice — 'dark' | 'light' | 'system' — or null while unset.
  // Unset means the build's default: dark. The choice is applied
  // through nativeTheme.themeSource, which is what sets
  // prefers-color-scheme for the hosted page and the shell's own
  // windows alike.
  let appearance = null;

  function effectiveAppearance() {
    return appearance || 'dark';
  }

  function applyAppearance() {
    try {
      if (ctx.nativeTheme) {
        ctx.nativeTheme.themeSource = effectiveAppearance();
      }
    } catch (error) {
      // No nativeTheme in this context (a stubbed shell): the
      // preference still persists and applies where the lever
      // exists.
    }
  }

  function setAppearance(next) {
    if (!['dark', 'light', 'system'].includes(next)) return;
    appearance = next;
    applyAppearance();
    saveState();
  }

  function loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (data && typeof data === 'object') {
        store.load(data.history);
        // academy5: the terminal skin is deleted. A state file
        // written by academy1–academy4 may still carry
        // terminalSkin / skinEpoch keys; they are read by nothing
        // and dropped on the next save.
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
        if (['dark', 'light', 'system'].includes(data.appearance)) {
          appearance = data.appearance;
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
        welcomeSeen: welcomeSeen,
        markdownRoute: markdownRoute,
        markdownDefaultPrevHandler: markdownDefaultPrevHandler,
        markdownDefaultNeverAsk: markdownDefaultNeverAsk,
        window: windowState,
        appearance: appearance,
      }), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (error) {
      console.warn('Could not save Academy state');
    }
  }
  loadState();
  // Dark by default, the owner's stored choice when there is
  // one: applied before any window exists, so the first paint of
  // a fresh profile is already dark.
  applyAppearance();

  function senderIsEndpoint(event) {
    try {
      return isEndpointOrigin(event.sender.getURL());
    } catch (error) {
      return false;
    }
  }

  function validKey(key) {
    return typeof key === 'string' && key.length > 0 && key.length <= 300;
  }

  ipcMain.handle('academy:history:list', (event, key) => {
    if (!senderIsEndpoint(event) || !validKey(key)) return [];
    return store.list(key);
  });

  ipcMain.handle('academy:history:add', (event, key, text) => {
    if (!senderIsEndpoint(event) || !validKey(key) || typeof text !== 'string') {
      return [];
    }
    const entries = store.add(key, text.slice(0, 20000));
    saveState();
    return entries;
  });

  // ---- Terminal view (0.4.0-academy5, files/19 section 10) ----
  // The terminal window is the shell's own renderer surface
  // (terminal.html + terminal-preload.cjs). It holds no session of
  // its own: a send is relayed to the hosted window, whose preload
  // drives the page's real composer and observes the message
  // stream as it renders; stream events flow back here and are
  // forwarded to the terminal window. If the hosted window or its
  // composer is absent the send FAILS with the reason — the
  // terminal never echoes a message locally as if it were sent.

  let hostedWindow = null;
  let terminalWindow = null;
  let appQuitting = false;
  let lastHostState = null;
  let termSendSeq = 0;
  const pendingSends = new Map();
  const pendingHistory = new Map();

  if (typeof app.on === 'function') {
    app.on('before-quit', () => { appQuitting = true; });
  }

  function findHostedWindow() {
    if (hostedWindow && !hostedWindow.isDestroyed()) return hostedWindow;
    hostedWindow = null;
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win === terminalWindow) continue;
        if (win.webContents && isEndpointOrigin(win.webContents.getURL())) {
          hostedWindow = win;
          break;
        }
      }
    } catch (error) { /* no hosted window yet */ }
    return hostedWindow;
  }

  function senderIsTerminal(event) {
    try {
      return Boolean(terminalWindow) && !terminalWindow.isDestroyed() &&
        event.sender === terminalWindow.webContents;
    } catch (error) {
      return false;
    }
  }

  function sendToTerminal(payload) {
    try {
      if (terminalWindow && !terminalWindow.isDestroyed()) {
        terminalWindow.webContents.send('academy:terminal:event', payload);
      }
    } catch (error) { /* terminal going away */ }
  }

  // Hosted preload -> main: stream + state events, forwarded to
  // the terminal window. Only the hosted window's events count.
  ipcMain.on('academy:terminal:event', (event, payload) => {
    if (!senderIsEndpoint(event) || !payload || typeof payload !== 'object') return;
    const host = findHostedWindow();
    if (host && event.sender !== host.webContents) return;
    if (payload.type === 'state') lastHostState = payload;
    sendToTerminal(payload);
  });

  ipcMain.on('academy:terminal:send-reply', (event, payload) => {
    if (!senderIsEndpoint(event) || !payload || !pendingSends.has(payload.id)) return;
    const pending = pendingSends.get(payload.id);
    pendingSends.delete(payload.id);
    clearTimeout(pending.timer);
    pending.resolve(payload);
  });

  ipcMain.on('academy:terminal:history-reply', (event, payload) => {
    if (!senderIsEndpoint(event) || !payload || !pendingHistory.has(payload.id)) return;
    const pending = pendingHistory.get(payload.id);
    pendingHistory.delete(payload.id);
    clearTimeout(pending.timer);
    pending.resolve(payload);
  });

  function relayToHost(channel, payload, pendingMap, timeoutMs, timeoutValue) {
    const host = findHostedWindow();
    if (!host) return Promise.resolve(timeoutValue);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingMap.delete(payload.id);
        resolve(timeoutValue);
      }, timeoutMs);
      pendingMap.set(payload.id, { resolve: resolve, timer: timer });
      try {
        host.webContents.send(channel, payload);
      } catch (error) {
        clearTimeout(timer);
        pendingMap.delete(payload.id);
        resolve(timeoutValue);
      }
    });
  }

  ipcMain.handle('academy:terminal:send', async (event, text) => {
    if (!senderIsTerminal(event)) {
      return { ok: false, error: 'Not the terminal window.' };
    }
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'Nothing to send.' };
    }
    const host = findHostedWindow();
    if (!host) {
      return {
        ok: false,
        error: 'The Minion window is not open yet — open it, sign in, then send.',
      };
    }
    termSendSeq += 1;
    const id = 'ts' + termSendSeq;
    const reply = await relayToHost(
      'academy:terminal:send-request',
      { id: id, text: text.slice(0, 20000) },
      pendingSends, 12000,
      {
        id: id, ok: false,
        error: 'The hosted page did not answer. Is the Minion window loaded and signed in?',
      });
    if (reply && reply.ok) {
      // The terminal's own sends also land in the fallback history
      // key, so up-arrow recall in the terminal works even when the
      // hosted conversation's history cannot be read back. (The
      // hosted preload separately records the send into the
      // conversation's own history when the page sends it.)
      store.add('minion:terminal', text.trim().slice(0, 20000));
      saveState();
    }
    return reply && typeof reply.ok === 'boolean'
      ? reply
      : { ok: false, error: 'The hosted page did not answer.' };
  });

  ipcMain.handle('academy:terminal:history', async (event) => {
    if (!senderIsTerminal(event)) return [];
    termSendSeq += 1;
    const id = 'th' + termSendSeq;
    const reply = await relayToHost(
      'academy:terminal:history-request',
      { id: id },
      pendingHistory, 3000, null);
    if (reply && Array.isArray(reply.items)) return reply.items;
    return store.list('minion:terminal');
  });

  ipcMain.handle('academy:terminal:info', (event) => {
    if (!senderIsTerminal(event)) return null;
    return {
      name: 'Minion',
      version: app.getVersion(),
      build: ctx.buildLabel || '',
    };
  });

  ipcMain.on('academy:terminal:show-hosted', (event) => {
    if (!senderIsTerminal(event)) return;
    const host = findHostedWindow();
    if (host) {
      try {
        if (host.isMinimized()) host.restore();
        host.show();
        host.focus();
      } catch (error) { /* window going away */ }
    }
    if (terminalWindow && !terminalWindow.isDestroyed()) terminalWindow.hide();
  });

  function showTerminal() {
    if (terminalWindow && !terminalWindow.isDestroyed()) {
      terminalWindow.show();
      terminalWindow.focus();
      return terminalWindow;
    }
    terminalWindow = new BrowserWindow({
      title: 'Terminal — Minion',
      width: 980,
      height: 640,
      minWidth: 560,
      minHeight: 360,
      backgroundColor: '#0a0a0a',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'terminal-preload.cjs'),
      },
    });
    // Marked so main's activate handler restores the hosted window,
    // not this one, on a Dock click.
    terminalWindow.__academyTerminal = true;
    // Hide on close, never destroy: the scrollback lives in this
    // renderer, and switching views must not lose it. A real
    // destroy happens only when the app quits.
    terminalWindow.on('close', (closeEvent) => {
      if (!appQuitting) {
        closeEvent.preventDefault();
        if (terminalWindow) terminalWindow.hide();
      }
    });
    terminalWindow.on('closed', () => { terminalWindow = null; });
    terminalWindow.webContents.once('did-finish-load', () => {
      if (lastHostState) sendToTerminal(lastHostState);
    });
    void terminalWindow.loadFile(path.join(__dirname, 'terminal.html'));
    return terminalWindow;
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
          'LaunchServices did not accept the change. Markdown files you download in Minion still open in MacDown; only the system-wide default is unchanged.');
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
      detail: 'MacDown already opens the markdown files you download in Minion. You can also make it the default app for markdown files everywhere on this Mac, Finder included. This changes only markdown files — plain text files are not affected. You can undo it any time in the View menu.',
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
          name: 'Minion',
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
      title: 'Welcome — Minion',
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
    // Capture the hosted window as it is created: the terminal
    // bridge relays to exactly this window's webContents.
    const open = () => {
      const win = openServiceWindow();
      if (win && win.webContents) hostedWindow = win;
    };
    if (welcomeSeen) {
      open();
      return;
    }
    showWelcome(open);
  }

  // ---- Application menu ----
  function buildMenu() {
    const template = [
      {
        label: app.getName(),
        submenu: [
          {
            role: 'about',
            label: 'About Minion',
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
            label: 'Terminal',
            accelerator: 'CmdOrCtrl+T',
            click: () => showTerminal(),
          },
          {
            label: 'Appearance',
            submenu: [
              {
                label: 'Dark',
                type: 'radio',
                checked: effectiveAppearance() === 'dark',
                click: () => setAppearance('dark'),
              },
              {
                label: 'Light',
                type: 'radio',
                checked: appearance === 'light',
                click: () => setAppearance('light'),
              },
              {
                label: 'System',
                type: 'radio',
                checked: appearance === 'system',
                click: () => setAppearance('system'),
              },
            ],
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
            label: 'Built by the Detroit Automation Academy on Electron 22.3.27',
            enabled: false,
          },
        ],
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }
  buildMenu();

  app.setAboutPanelOptions({
    applicationName: 'Minion',
    applicationVersion: ctx.buildLabel || '0.4.1',
    version: '0.4.1',
    copyright:
      'Unofficial build: not a Meta product and not endorsed by Meta. ' +
      'The application layer is MIT-licensed open source; the license ' +
      'and attribution are in the LICENSE file inside the app bundle. ' +
      'Academy build by the Detroit Automation Academy.',
  });

  return {
    gateWelcome: gateWelcome,
    showWelcome: () => showWelcome(),
    showTerminal: showTerminal,
    getMarkdownRoute: () => markdownRoute,
    setMarkdownRoute: setMarkdownRoute,
    offerMarkdownDefault: offerMarkdownDefault,
    setMarkdownDefaultEnabled: setMarkdownDefaultEnabled,
    getMarkdownDefaultState: () => ({
      prevHandler: markdownDefaultPrevHandler,
      neverAsk: markdownDefaultNeverAsk,
      isCurrent: markdownDefaultIsCurrent(),
    }),
    getAppearance: () => effectiveAppearance(),
    setAppearance: setAppearance,
    getWindowState: () => windowState,
    setWindowState: (bounds, isMaximized) => {
      windowState = { bounds: bounds || null, isMaximized: !!isMaximized };
      saveState();
    },
  };
}

module.exports = { earlyInit: earlyInit, install: install };
