const { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile, execFileSync } = require("node:child_process");

const MUSE_URL = "https://muse.ai/";
const {
  isTrustedNavigation,
  isAllowedExternalUrl,
  isMuseOrigin,
  uniqueDownloadPath,
} = require("./utils.cjs");
// Academy build (v0.4.0-academy): feature layer + window-management
// repair (owner escalation 2026-11-10; defect register in files/19).
// academy.cjs: sent-message history, terminal view (academy5; the
// terminal skin it replaced is deleted), SDS-8 welcome, application
// menu, state persistence. window-law.cjs (T1 scaffold)
// supplies the clamp; window-state.cjs the restore validation +
// cascade geometry. The law applied: no window opens partially
// off-screen, no window opens exactly on top of the active one,
// bounds are restored only when they still land on a real display,
// and activating the app restores its window. Popup windows keep
// Chromium's opener relationship (see configureWindowNavigation):
// re-parenting them into panes would break Meta sign-in, so the
// pane stack from the T1 design is NOT applied to popups; they get
// computed, clamped initial bounds instead.
const academy = require("./academy.cjs");
const {
  createMarkdownRouter,
  DISTRO_BUNDLE_ID,
} = require("./md-route.cjs");
const { clampRectToVisibleFrame } = require("./window-law.cjs");
const {
  validateRestoreBounds,
  placementFor,
} = require("./window-state.cjs");

const ACADEMY_BUILD_LABEL = "0.4.0-minion2";
const ACADEMY_PRELOAD = path.join(__dirname, "preload.cjs");

// Set by start() once the feature layer is installed; window
// creation reads saved bounds through it.
let academyLayer = null;

// Markdown routing (Distro files/24): set by start() once the
// feature layer exists (the router reads the owner's preference
// through it). configureSession's download handler consults it at
// completion time; downloads are the shell-owned encounter.
let markdownRouter = null;

function openWithBundleId(bundleId, filePath) {
  return new Promise((resolve) => {
    const args = filePath ? ["-b", bundleId, filePath] : ["-b", bundleId];
    execFile("/usr/bin/open", args, (error) => resolve(!error));
  });
}

function readBundleId(appPath) {
  try {
    return execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", path.join(appPath, "Contents", "Info.plist")],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
  } catch {
    return null;
  }
}

// MD-T3 helper client (files/24 section 5b): the bundled
// AcademyLSDefault binary speaks get | set | restore for
// net.daringfireball.markdown only. A missing or failing helper
// reads as "unavailable" everywhere — the feature degrades to
// academy3 behavior, never to an error.
function createLsDefaultClient() {
  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, "AcademyLSDefault")
    : path.join(__dirname, "AcademyLSDefault");
  const run = (args) =>
    new Promise((resolve) => {
      execFile(helperPath, args, { timeout: 5000 }, (error) =>
        resolve(!error),
      );
    });
  return {
    available: () => {
      try {
        return fs.existsSync(helperPath);
      } catch {
        return false;
      }
    },
    getSync: () => {
      try {
        const out = execFileSync(helperPath, ["get"], {
          encoding: "utf8",
          timeout: 5000,
        });
        const value = String(out).trim();
        return value || null;
      } catch {
        return null;
      }
    },
    set: () => run(["set"]),
    restore: (bundleId) => run(["restore", bundleId]),
  };
}

function installMarkdownRouter() {
  markdownRouter = createMarkdownRouter({
    statSync: (p) => fs.statSync(p),
    realpathSync: (p) => fs.realpathSync(p),
    readBundleId,
    homeDir: os.homedir(),
    openWithBundle: (bundleId, filePath) => openWithBundleId(bundleId, filePath),
    openSystemDefault: async (filePath) => {
      const error = await shell.openPath(filePath);
      return error === "";
    },
    openDistro: async () => {
      // DISTRO-DL1: prefer the deep link — it lands on MacDown's
      // detail pane, not just the storefront. If no handler claims
      // the scheme (older Distro), fall back to opening the app.
      try {
        await shell.openExternal("academy-distro://app/macdown");
        return true;
      } catch {
        return openWithBundleId(DISTRO_BUNDLE_ID);
      }
    },
    onFirstSuccessfulRoute: () => {
      // MD-T3: the one-time consented-default offer rides the
      // first successful route of the session.
      if (academyLayer) void academyLayer.offerMarkdownDefault();
    },
    showMessageBox: (options) => {
      const win = BrowserWindow.getFocusedWindow();
      return win
        ? dialog.showMessageBox(win, options)
        : dialog.showMessageBox(options);
    },
    getPreference: () =>
      academyLayer ? academyLayer.getMarkdownRoute() : "macdown",
    log: (message) => console.warn(message),
  });
}

function clampRectToWorkArea(wanted) {
  const display = screen.getDisplayMatching(wanted);
  return clampRectToVisibleFrame(wanted, display.workArea);
}

function clampWindowBounds(window, wanted) {
  try {
    const rect = clampRectToWorkArea(wanted);
    if (rect.clamped) {
      console.warn("WindowLaw: clamped window bounds", { wanted, rect });
    }
    window.setBounds(rect);
  } catch {
    console.warn("WindowLaw: could not clamp window bounds");
  }
}

// Where the main window opens. Order: the owner's saved bounds,
// validated against the displays that exist NOW (a rect stranded on
// a removed monitor is discarded, never restored into the void) —
// else the default size at the primary display. The result is
// cascaded past any live windows and clamped fully on-screen:
// a window of this app never opens partially off-screen or exactly
// on top of the active one (fix spec 2026-11-08, rules 1-2).
function mainWindowPlacement() {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const primary = screen.getPrimaryDisplay().workArea;
  let base = null;
  let restoreMaximized = false;
  try {
    const saved = academyLayer ? academyLayer.getWindowState() : null;
    if (saved && saved.bounds) {
      base = validateRestoreBounds(saved.bounds, displays);
      if (base) restoreMaximized = !!saved.isMaximized;
    }
  } catch {
    base = null;
  }
  if (!base) {
    base = {
      x: primary.x + Math.max(0, Math.floor((primary.width - 1180) / 2)),
      y: primary.y + Math.max(0, Math.floor((primary.height - 820) / 2)),
      width: 1180,
      height: 820,
    };
  }
  const wanted = placementFor(base, BrowserWindow.getAllWindows().length);
  return { rect: clampRectToWorkArea(wanted), restoreMaximized };
}

// Persist the main window's normal bounds as the owner leaves them,
// so the next launch restores the arrangement (10.13 floor: the
// saved rect is validated at restore, see mainWindowPlacement).
function trackWindowState(window) {
  let timer = null;
  const snapshot = () => {
    try {
      if (window.isDestroyed() || !academyLayer) return;
      academyLayer.setWindowState(
        window.getNormalBounds(),
        window.isMaximized(),
      );
    } catch {
      // best-effort persistence only
    }
  };
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(snapshot, 400);
  };
  window.on("resize", debounced);
  window.on("move", debounced);
  window.on("close", snapshot);
}

function openExternalUrl(url) {
  if (isAllowedExternalUrl(url)) {
    void shell
      .openExternal(url)
      .catch(() => console.warn("Could not open external link"));
  }
}

function configureSession(ses) {
  // Electron uses this write-only permission for navigator.clipboard.writeText().
  // Do not grant clipboard-read: copying does not require reading the clipboard.
  const allowedPermissions = new Set([
    "notifications",
    "clipboard-sanitized-write",
  ]);
  ses.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => {
      return (
        allowedPermissions.has(permission) && isMuseOrigin(requestingOrigin)
      );
    },
  );

  ses.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl ?? "";
      callback(
        allowedPermissions.has(permission) && isMuseOrigin(requestingUrl),
      );
    },
  );

  ses.on("will-download", (_event, item) => {
    let destination;
    const cleanup = () => {
      if (!destination) return;
      try {
        fs.rmSync(destination, { force: true });
      } catch {
        console.warn("Could not remove failed download destination");
      }
    };
    try {
      const filename = item.getFilename();
      const mimeType = item.getMimeType();
      destination = uniqueDownloadPath(
        app.getPath("downloads"),
        filename,
      );
      item.once("done", (_event, state) => {
        if (state !== "completed") {
          cleanup();
          return;
        }
        // Markdown routing (files/24): a completed download the
        // classifier calls markdown opens in MacDown per the
        // owner's preference. The router's allowlist holds only
        // destinations this handler reserved (noted below).
        if (markdownRouter) {
          void markdownRouter
            .handleCompletedDownload({
              destination,
              savePath: item.getSavePath(),
              filename,
              mimeType,
            })
            .catch(() => console.warn("MarkdownRoute: routing failed"));
        }
      });
      item.setSavePath(destination);
      if (markdownRouter) markdownRouter.noteDownload(destination);
    } catch {
      cleanup();
      item.cancel();
      console.warn("Could not reserve download destination");
    }
  });
}

// Let Chromium create the child so window.opener, postMessage, POST bodies,
// and window.open('') followed by an asynchronous location assignment survive.
// A manually-created window or an OS browser cannot preserve that relationship.
function configureWindowNavigation(window, isPopup = false) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (url !== "about:blank" && url !== "" && !isAllowedExternalUrl(url)) {
      return { action: "deny" };
    }
    // WindowLaw: the popup's INITIAL bounds are computed here —
    // offset from the opener, then clamped fully inside the
    // opener's display — so it never spawns partially off-screen
    // (the 2026-11-08 defect). Previously no position was given at
    // all and placement was left to cascade chance.
    let popupBounds = { width: 600, height: 760 };
    try {
      const opener = window.getBounds();
      const wanted = {
        x: opener.x + 28,
        y: opener.y + 28,
        width: 600,
        height: 760,
      };
      popupBounds = clampRectToWorkArea(wanted);
    } catch {
      // fall back to size-only; did-create-window re-clamps.
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: window,
        width: popupBounds.width,
        height: popupBounds.height,
        x: popupBounds.x,
        y: popupBounds.y,
        show: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          sandbox: true,
          webSecurity: true,
          partition: "persist:muse",
          // Academy build: the feature preload (history + terminal
          // bridge) applies to popup windows on the muse.ai origin
          // too.
          preload: ACADEMY_PRELOAD,
        },
      },
    };
  });
  contents.on("did-create-window", (child) => {
    configureWindowNavigation(child, true);
    // WindowLaw: a popup never opens partially off-screen either.
    clampWindowBounds(child, child.getBounds());
    // Do not leave authentication windows alive after their opener closes.
    const closeChild = () => {
      if (!child.isDestroyed()) child.destroy();
    };
    window.once("closed", closeChild);
    child.once("closed", () => window.removeListener("closed", closeChild));
  });

  const guardNavigation = (event, url, _isInPlace, isMainFrame = true) => {
    const allowed = isPopup
      ? url === "about:blank" || isAllowedExternalUrl(url)
      : isMainFrame
        ? isTrustedNavigation(url)
        : // Hosted apps can redirect to a separate content origin. Keep the
          // top-level allowlist without canceling safe iframe redirects.
          isAllowedExternalUrl(url);
    if (!allowed) {
      event.preventDefault();
      if (!isPopup && isMainFrame) openExternalUrl(url);
    }
  };
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);
}

function createMuseWindow() {
  // WindowLaw placement (see mainWindowPlacement): upstream created
  // this window with a size and NO position and no clamp — on the
  // Air's 1280-1440px displays the OS cascade could and did park
  // windows partially off-screen (files/18 P1, fix spec 2026-11-08).
  const placement = mainWindowPlacement();
  const window = new BrowserWindow({
    title: "Minion",
    x: placement.rect.x,
    y: placement.rect.y,
    width: placement.rect.width,
    height: placement.rect.height,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: "#101117",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:muse",
      // Academy build: feature preload (history + terminal bridge).
      preload: ACADEMY_PRELOAD,
    },
  });
  if (placement.restoreMaximized) {
    try {
      window.maximize();
    } catch {
      // bounds already guarantee a usable window
    }
  }
  trackWindowState(window);

  configureWindowNavigation(window);

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  async function loadMuse() {
    while (!window.isDestroyed()) {
      try {
        await window.loadURL(MUSE_URL);
        return;
      } catch {
        if (window.isDestroyed()) return;
        // A failed first request may never emit ready-to-show.
        window.show();
        const { response } = await dialog.showMessageBox(window, {
          type: "error",
          title: "Could not load Muse",
          message: "Muse could not be reached.",
          detail: "Check your internet connection, then try again.",
          buttons: ["Retry", "Close"],
          defaultId: 0,
          cancelId: 1,
        });
        if (window.isDestroyed()) return;
        if (response !== 0) {
          window.close();
          return;
        }
      }
    }
  }
  void loadMuse().catch(() =>
    console.warn("Could not show Muse load recovery"),
  );
  return window;
}

function start() {
  // Academy build: autoplay policy for the SDS-8 welcome sound.
  academy.earlyInit(app);

  // Align the running window with the installed Linux desktop entry so desktop
  // shells (GNOME, KDE) resolve the muse-desktop icon via WM_CLASS/app_id.
  // app.setDesktopName was added in Electron 24; on Electron 22 (the last
  // line that runs on macOS 10.13) skip it instead of throwing at startup.
  if (process.platform === "linux" && typeof app.setDesktopName === "function") {
    app.setDesktopName("muse-desktop.desktop");
  }

  // App data stored separately (owner coding standard, J dir
  // 2026-11-10 22:18 EST): the app's data lives outside the
  // bundle, in its own Application Support location keyed to the
  // bundle identity — ~/Library/Application Support/
  // com.detroitautomationacademy.minion. Nothing user-data is
  // kept inside the .app. The previous version (Muse (Academy
  // Build), the declared predecessor) pinned its data to
  // ~/Library/Application Support/Muse; that store stays
  // untouched under its own location, and removing either
  // version's bundle never touches either data store.
  app.setPath("userData", path.join(app.getPath("appData"), "com.detroitautomationacademy.minion"));

  app.whenReady().then(() => {
    configureSession(session.fromPartition("persist:muse"));
    // Academy build: install the feature layer, then the SDS-8
    // welcome gate decides whether the service window opens now or
    // after the owner's Continue (first launch only).
    academyLayer = academy.install({
      app,
      BrowserWindow,
      Menu,
      dialog,
      ipcMain,
      buildLabel: ACADEMY_BUILD_LABEL,
      lsDefault: createLsDefaultClient(),
    });
    installMarkdownRouter();
    academyLayer.gateWelcome(createMuseWindow);
    app.on("activate", () => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        academyLayer.gateWelcome(createMuseWindow);
        return;
      }
      // Upstream's handler did nothing when a window existed: a
      // minimized window stayed minimized and a hidden one stayed
      // hidden when the owner clicked the Dock icon — the app read
      // as dead. Restore + focus the first window instead (the
      // standard macOS behavior the platform template encodes).
      // academy5: the Terminal window hides instead of closing, so
      // it can be in this list while hidden — a Dock click restores
      // the hosted window, never the terminal.
      const first = windows.find((w) => !w.__academyTerminal) || windows[0];
      try {
        if (first.isMinimized()) first.restore();
        if (!first.isVisible()) first.show();
        first.focus();
      } catch {
        // window going away mid-activate: the next activate retries
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

start();
