'use strict';
/*
 * md-route.cjs — Muse (Academy Build), main process.
 *
 * The markdown router (design record: Distro files/24). When a
 * download completes in the shell and the classifier
 * (md-classify.cjs) calls it markdown, the router opens it in
 * MacDown — the Academy's markdown editor — per the owner's
 * markdownRoute preference. Everything here is main-process: no
 * preload surface, no IPC, no page-side interception (the
 * terminal-skin lesson, files/19 section 6).
 *
 * SECURITY ALLOWLIST (files/24 section 7). The router takes paths
 * from exactly one class in this build: destinations the shell
 * itself reserved via uniqueDownloadPath in THIS session and saw
 * reach "completed" (Class A). main.cjs notes each reserved
 * destination with noteDownload(); membership is required before
 * any routing, and the completion-time realpath is compared
 * before the open. A path string from page JS or the preload can
 * never enter — this module registers no IPC at all. (Class B,
 * OS-mediated picks, arrives with MD-T2's shell-owned file flows.)
 *
 * The router is built by a factory over an injected environment
 * so the whole decision tree runs under plain Node in
 * test/run-tests.cjs; main.cjs supplies the Electron-backed env.
 */

const path = require('node:path');
const { classifyDownload } = require('./md-classify.cjs');

const MACDOWN_BUNDLE_ID = 'com.detroitautomationacademy.macdown';
const DISTRO_BUNDLE_ID = 'com.detroitautomationacademy.distro';

// files/24 section 7: above this size the owner is asked first —
// MacDown is a 10.13-era editor and the rig has 4 GB of RAM. The
// constant is named (MARKDOWN_ROUTE_MAX_BYTES in the design) so
// the Air sitting can retune it from evidence.
const ROUTE_MAX_BYTES = 10 * 1024 * 1024;

const PREFERENCES = new Set(['macdown', 'ask', 'system']);

function macdownCandidatePaths(homeDir) {
  return [
    '/Applications/MacDown.app',
    path.join(homeDir, 'Applications', 'MacDown.app'),
  ];
}

// --- Dialog shapes (pure; tests pin the button contracts) ---

function absentDialogOptions(filename) {
  return {
    type: 'info',
    message: "MacDown isn't installed.",
    detail:
      "Markdown files open in MacDown, the Academy's markdown editor — " +
      "it isn't on this Mac yet. " + filename + ' is saved in Downloads.',
    buttons: ['Get MacDown in Distro', 'Open with System Default', 'Keep in Downloads'],
    defaultId: 0,
    cancelId: 2,
  };
}

function askDialogOptions(filename) {
  return {
    type: 'question',
    message: 'Open this markdown file in MacDown?',
    detail:
      filename + ' was downloaded. MacDown is the Academy\'s markdown ' +
      'editor; the file stays in Downloads either way.',
    buttons: ['MacDown', 'System Default', 'Downloads Only'],
    defaultId: 0,
    cancelId: 2,
  };
}

function oversizeDialogOptions(filename, sizeBytes) {
  const mib = (sizeBytes / (1024 * 1024)).toFixed(1);
  return {
    type: 'warning',
    message: 'This markdown file is large.',
    detail:
      filename + ' is ' + mib + ' MiB. Opening very large files can ' +
      'make MacDown unresponsive on this Mac; the file is saved in ' +
      'Downloads either way.',
    buttons: ['Open Anyway', 'Keep in Downloads'],
    defaultId: 1,
    cancelId: 1,
  };
}

// env contract (main.cjs supplies the real one):
//   statSync(p) -> { isFile(), size }      (throws when missing)
//   realpathSync(p) -> string
//   readBundleId(appPath) -> string|null   (PlistBuddy readback)
//   homeDir -> string
//   openWithBundle(bundleId, filePath) -> Promise<boolean>
//   openSystemDefault(filePath) -> Promise<boolean>
//   openDistro() -> Promise<boolean>       (the §4 first button)
//   showMessageBox(options) -> Promise<{ response }>
//   getPreference() -> 'macdown'|'ask'|'system'
//   onFirstSuccessfulRoute()               (optional; MD-T3 hook)
//   log(message)                           (optional)
function createMarkdownRouter(env) {
  const noted = new Set(); // Class A allowlist: realpaths
  let macdownPresent = null; // detection cache; null = unknown

  function log(message) {
    if (typeof env.log === 'function') env.log(message);
  }

  function noteDownload(destination) {
    try {
      noted.add(env.realpathSync(destination));
    } catch (error) {
      noted.add(destination);
    }
  }

  function isAllowlisted(destination) {
    try {
      return noted.has(env.realpathSync(destination));
    } catch (error) {
      return false;
    }
  }

  // Detection order (files/24 section 3): cheap path checks first,
  // each verified by bundle-id readback. A false here is NOT a
  // declaration of absence — LaunchServices may know an install
  // elsewhere, so the route still attempts the open once; only an
  // open failure declares absence (and invalidates the cache).
  function detectMacDown() {
    if (macdownPresent !== null) return macdownPresent;
    for (const candidate of macdownCandidatePaths(env.homeDir)) {
      try {
        if (env.readBundleId(candidate) === MACDOWN_BUNDLE_ID) {
          macdownPresent = true;
          return true;
        }
      } catch (error) { /* unreadable candidate: keep looking */ }
    }
    macdownPresent = false;
    return false;
  }

  async function openInMacDown(destination, savePath) {
    // TOCTOU guard (files/24 section 7): the path that completed
    // must be the path that opens — canonical forms compared.
    try {
      if (env.realpathSync(destination) !== env.realpathSync(savePath)) {
        log('MarkdownRoute: completion path mismatch; refusing to route');
        return false;
      }
    } catch (error) {
      log('MarkdownRoute: could not verify completion path');
      return false;
    }
    detectMacDown(); // warms the cache; the open below is the authority
    const ok = await env.openWithBundle(MACDOWN_BUNDLE_ID, destination);
    if (ok) {
      macdownPresent = true;
      if (typeof env.onFirstSuccessfulRoute === 'function') {
        try {
          env.onFirstSuccessfulRoute();
        } catch (error) { /* the hook never blocks the open it follows */ }
      }
      return true;
    }
    macdownPresent = false;
    return false;
  }

  async function showAbsentDialog(destination, filename) {
    const { response } = await env.showMessageBox(absentDialogOptions(filename));
    if (response === 0) {
      await env.openDistro();
      return 'absent-distro';
    }
    if (response === 1) {
      await env.openSystemDefault(destination);
      return 'absent-system';
    }
    return 'absent-kept';
  }

  // The one entry point. `download` = { destination, savePath,
  // filename, mimeType } from the will-download completion.
  // Returns an outcome token (also the test surface):
  //   not-allowlisted | not-markdown | preference-system |
  //   missing | not-a-file | kept-oversize | ask-system |
  //   ask-downloads-only | routed-macdown | absent-distro |
  //   absent-system | absent-kept
  async function handleCompletedDownload(download) {
    const { destination, savePath, filename, mimeType } = download;
    if (!isAllowlisted(destination)) return 'not-allowlisted';
    if (!classifyDownload(filename, mimeType)) return 'not-markdown';
    const preference = PREFERENCES.has(env.getPreference())
      ? env.getPreference()
      : 'macdown';
    if (preference === 'system') return 'preference-system';
    let stat;
    try {
      stat = env.statSync(destination);
    } catch (error) {
      return 'missing';
    }
    if (!stat.isFile()) return 'not-a-file';
    if (stat.size > ROUTE_MAX_BYTES) {
      const { response } = await env.showMessageBox(
        oversizeDialogOptions(filename, stat.size)
      );
      if (response !== 0) return 'kept-oversize';
    }
    if (preference === 'ask') {
      const { response } = await env.showMessageBox(askDialogOptions(filename));
      if (response === 1) {
        await env.openSystemDefault(destination);
        return 'ask-system';
      }
      if (response !== 0) return 'ask-downloads-only';
    }
    if (await openInMacDown(destination, savePath || destination)) {
      return 'routed-macdown';
    }
    return showAbsentDialog(destination, filename);
  }

  return {
    noteDownload,
    isAllowlisted,
    detectMacDown,
    handleCompletedDownload,
  };
}

module.exports = {
  MACDOWN_BUNDLE_ID,
  DISTRO_BUNDLE_ID,
  ROUTE_MAX_BYTES,
  PREFERENCES,
  macdownCandidatePaths,
  absentDialogOptions,
  askDialogOptions,
  oversizeDialogOptions,
  createMarkdownRouter,
};
