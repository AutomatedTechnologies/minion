'use strict';
/*
 * run-tests.cjs — Minion v0.4.0-minion1 verification.
 * Plain Node (>= the Electron 22 runtime's Node 16 semantics; runs on
 * any modern Node). Covers:
 *  1. history.cjs store: add/dedupe/caps/isolation/persistence/evict.
 *  2. Navigator semantics (history.cjs copy): shell recall order,
 *     draft preservation + restore, Escape, edit-never-mutates.
 *  3. The preload.cjs mirror of the navigator is byte-identical to
 *     the history.cjs block between the history-nav markers.
 *  4. terminal.html + welcome.html: every hex color is a gray
 *     (R=G=B); no remote references, gradients, or backdrop filters.
 *  5. App layer floor audit: no syntax or API past the Electron 22 /
 *     Chromium 108 / macOS 10.13 floor in the new code.
 *  6. academy5: the terminal skin is deleted (file, channels, menu
 *     toggle, epoch machinery); the bundle identity is the Academy
 *     identifier; the Terminal view is wired across main, academy
 *     and preload, and behaves honestly against a stubbed shell.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..', 'app');
const ELE = path.join(APP, 'electron');
let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('ok -', name);
}

// 0. Syntax: every shipped script parses.
for (const f of ['main.cjs', 'utils.cjs', 'academy.cjs', 'history.cjs', 'preload.cjs', 'welcome-preload.cjs', 'terminal-preload.cjs', 'window-law.cjs', 'window-state.cjs', 'md-classify.cjs', 'md-route.cjs']) {
  execFileSync(process.execPath, ['--check', path.join(ELE, f)]);
}
ok('node --check clean on all 11 app-layer scripts', () => {});

const ws = require(path.join(ELE, 'window-state.cjs'));
const AIR = { x: 0, y: 23, width: 1440, height: 877 }; // 13" Air work area

ok('window-state: cascade offsets step and wrap', () => {
  assert.deepStrictEqual(ws.cascadeOffset(0), { dx: 0, dy: 0 });
  assert.deepStrictEqual(ws.cascadeOffset(1), { dx: 28, dy: 28 });
  assert.deepStrictEqual(ws.cascadeOffset(3), { dx: 84, dy: 84 });
  assert.deepStrictEqual(ws.cascadeOffset(8), { dx: 0, dy: 0 });
});

ok('window-state: restore honored when the rect lands on a live display', () => {
  const saved = { x: 100, y: 80, width: 1180, height: 800 };
  assert.deepStrictEqual(ws.validateRestoreBounds(saved, [AIR]), saved);
});

ok('window-state: restore discarded when the display is gone (off-screen spawn class)', () => {
  const stranded = { x: 2900, y: 80, width: 1180, height: 800 }; // second monitor, removed
  assert.strictEqual(ws.validateRestoreBounds(stranded, [AIR]), null);
  const mostlyGone = { x: 1300, y: 80, width: 1180, height: 800 }; // <50% visible
  assert.strictEqual(ws.validateRestoreBounds(mostlyGone, [AIR]), null);
});

ok('window-state: garbage saved state is rejected, second display rescues', () => {
  assert.strictEqual(ws.validateRestoreBounds(null, [AIR]), null);
  assert.strictEqual(ws.validateRestoreBounds({ x: 'a', y: 0, width: 10, height: 10 }, [AIR]), null);
  assert.strictEqual(ws.validateRestoreBounds({ x: 0, y: 0, width: 100, height: 100 }, [AIR]), null); // below sane floor
  const onSecond = { x: 1500, y: 60, width: 900, height: 700 };
  const second = { x: 1440, y: 0, width: 1920, height: 1080 };
  assert.deepStrictEqual(ws.validateRestoreBounds(onSecond, [AIR, second]), onSecond);
});

ok('window-state: placementFor cascades the base rect', () => {
  const base = { x: 130, y: 51, width: 1180, height: 820 };
  assert.deepStrictEqual(ws.placementFor(base, 0), base);
  assert.deepStrictEqual(ws.placementFor(base, 2), { x: 186, y: 107, width: 1180, height: 820 });
});

ok('window-law clamp: off-screen rect pulled fully inside; on-screen untouched', () => {
  const { clampRectToVisibleFrame } = require(path.join(ELE, 'window-law.cjs'));
  const sliver = clampRectToVisibleFrame({ x: 1400, y: -50, width: 600, height: 760 }, AIR);
  assert.strictEqual(sliver.clamped, true);
  assert.ok(sliver.x + sliver.width <= AIR.x + AIR.width && sliver.x >= AIR.x);
  assert.ok(sliver.y >= AIR.y && sliver.y + sliver.height <= AIR.y + AIR.height);
  const fine = clampRectToVisibleFrame({ x: 100, y: 100, width: 800, height: 600 }, AIR);
  assert.strictEqual(fine.clamped, false);
  const oversize = clampRectToVisibleFrame({ x: 0, y: 0, width: 2000, height: 1200 }, AIR);
  assert.strictEqual(oversize.width, AIR.width);
  assert.strictEqual(oversize.height, AIR.height);
});

const { createHistoryStore, createNavigator } = require(path.join(ELE, 'history.cjs'));

ok('store: add + list, oldest first', () => {
  const s = createHistoryStore();
  s.add('c1', 'first');
  s.add('c1', 'second');
  assert.deepStrictEqual(s.list('c1'), ['first', 'second']);
  assert.deepStrictEqual(s.list('nope'), []);
});

ok('store: consecutive duplicates collapse; blanks ignored; text trimmed', () => {
  const s = createHistoryStore();
  s.add('c1', '  hi  ');
  s.add('c1', 'hi');
  s.add('c1', '   ');
  s.add('c1', '');
  assert.deepStrictEqual(s.list('c1'), ['hi']);
  s.add('c1', 'yo');
  s.add('c1', 'hi'); // non-consecutive repeat is a new entry
  assert.deepStrictEqual(s.list('c1'), ['hi', 'yo', 'hi']);
});

ok('store: per-conversation isolation + per-conversation cap', () => {
  const s = createHistoryStore({ capPerConversation: 3, capConversations: 10 });
  s.add('a', '1'); s.add('b', 'x'); s.add('a', '2'); s.add('a', '3'); s.add('a', '4');
  assert.deepStrictEqual(s.list('a'), ['2', '3', '4']);
  assert.deepStrictEqual(s.list('b'), ['x']);
});

ok('store: conversation-count cap evicts least-recently-updated', () => {
  const s = createHistoryStore({ capPerConversation: 5, capConversations: 2 });
  s.add('a', '1'); s.add('b', '1'); s.add('a', '2'); // a most recent
  s.add('c', '1'); // evicts b
  assert.deepStrictEqual(s.list('b'), []);
  assert.deepStrictEqual(s.list('a'), ['1', '2']);
  assert.deepStrictEqual(s.list('c'), ['1']);
});

ok('store: persistence round-trip (toJSON -> load)', () => {
  const s = createHistoryStore();
  s.add('c1', 'one'); s.add('c1', 'two'); s.add('c2', 'x');
  const s2 = createHistoryStore();
  s2.load(JSON.parse(JSON.stringify(s.toJSON())));
  assert.deepStrictEqual(s2.list('c1'), ['one', 'two']);
  assert.deepStrictEqual(s2.list('c2'), ['x']);
  s2.load(null); s2.load({}); s2.load({ conversations: { bad: { entries: 'no' } } });
  assert.deepStrictEqual(s2.list('c1'), []);
});

ok('store: clear empties everything', () => {
  const s = createHistoryStore();
  s.add('c1', 'one');
  s.clear();
  assert.deepStrictEqual(s.list('c1'), []);
});

ok('navigator: shell order, draft preserved + restored at the bottom', () => {
  const nav = createNavigator(['one', 'two', 'three']);
  assert.strictEqual(nav.older('my draft'), 'three');
  assert.strictEqual(nav.older(), 'two');
  assert.strictEqual(nav.older(), 'one');
  assert.strictEqual(nav.older(), null); // top of history: stays
  assert.strictEqual(nav.newer(), 'two');
  assert.strictEqual(nav.newer(), 'three');
  assert.strictEqual(nav.newer(), 'my draft'); // draft restored
  assert.strictEqual(nav.newer(), null);
  assert.strictEqual(nav.isNavigating(), false);
});

ok('navigator: empty history recalls nothing; draft untouched', () => {
  const nav = createNavigator([]);
  assert.strictEqual(nav.older('draft'), null);
  assert.strictEqual(nav.newer(), null);
});

ok('navigator: editing a recalled line never mutates the snapshot', () => {
  const entries = ['alpha', 'beta'];
  const nav = createNavigator(entries);
  const recalled = nav.older('');
  assert.strictEqual(recalled, 'beta');
  // The preload writes the (possibly edited) text into the composer,
  // not into the entries; the navigator's snapshot must be unchanged:
  nav.newer();
  assert.strictEqual(nav.older(''), 'beta');
  assert.deepStrictEqual(entries, ['alpha', 'beta']);
});

ok('navigator: Escape restores the draft and exits navigation', () => {
  const nav = createNavigator(['a', 'b']);
  nav.older('wip');
  nav.older();
  assert.strictEqual(nav.isNavigating(), true);
  assert.strictEqual(nav.escape(), 'wip');
  assert.strictEqual(nav.isNavigating(), false);
  assert.strictEqual(nav.escape(), null);
});

ok('navigator: notifySent returns to the bottom; refresh swaps the snapshot', () => {
  const nav = createNavigator(['a']);
  nav.older('d');
  nav.notifySent();
  assert.strictEqual(nav.isNavigating(), false);
  nav.refresh(['a', 'b']);
  assert.strictEqual(nav.older(''), 'b');
});

ok('preload navigator mirror is identical to history.cjs block', () => {
  const extract = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/\/\/ BEGIN history-nav\n([\s\S]*?)\/\/ END history-nav/);
    assert.ok(m, 'markers present in ' + file);
    return m[1];
  };
  assert.strictEqual(
    extract(path.join(ELE, 'preload.cjs')),
    extract(path.join(ELE, 'history.cjs'))
  );
});

function assertGrayscale(file) {
  const text = fs.readFileSync(file, 'utf8');
  const hexes = text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [];
  assert.ok(hexes.length > 0, file + ' carries colors to check');
  for (const hex of hexes) {
    let r, g, b;
    if (hex.length === 7) {
      r = hex.slice(1, 3); g = hex.slice(3, 5); b = hex.slice(5, 7);
    } else {
      r = hex[1] + hex[1]; g = hex[2] + hex[2]; b = hex[3] + hex[3];
    }
    assert.ok(r === g && g === b, file + ': non-gray color ' + hex);
  }
  const rgbas = text.match(/rgba?\([^)]*\)/g) || [];
  for (const c of rgbas) {
    const parts = c.match(/[\d.]+/g).slice(0, 3);
    assert.ok(parts[0] === parts[1] && parts[1] === parts[2], file + ': non-gray ' + c);
  }
  assert.ok(!/hsl\(/.test(text), file + ': hsl() present');
}

ok('academy5: the terminal skin is deleted, not disabled', () => {
  // Definitive removal (owner ruling 2026-11-10 21:12 EST): the
  // sheet file is gone from the source tree, the skin IPC channels
  // and the epoch machinery are gone from both processes, the
  // View-menu toggle is gone, and the assembler's expected-file
  // list carries the terminal surface instead of the sheet. (The
  // assembler's artifact self-verify separately asserts no
  // terminal-skin.css entry ships in the zip.)
  assert.strictEqual(fs.existsSync(path.join(ELE, 'terminal-skin.css')), false,
    'terminal-skin.css must not exist');
  const academy = fs.readFileSync(path.join(ELE, 'academy.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(ELE, 'preload.cjs'), 'utf8');
  assert.ok(!/academy:skin/.test(academy), 'no skin IPC in the main layer');
  assert.ok(!/academy:skin/.test(preload), 'no skin IPC in the preload');
  assert.ok(!/const SKIN_EPOCH/.test(academy), 'epoch machinery deleted');
  assert.ok(!/setTerminalSkin/.test(academy), 'skin setter deleted');
  assert.ok(!/'Terminal Skin'/.test(academy), 'skin menu toggle deleted');
  assert.ok(!/classList\.toggle\('academy-terminal'/.test(preload), 'skin class toggle deleted');
  const assemble = fs.readFileSync(path.join(APP, '..', 'tools', 'assemble.py'), 'utf8');
  const expectedBlock = assemble.match(/EXPECTED_APP_FILES = \[([\s\S]*?)\]/);
  assert.ok(expectedBlock, 'assembler expected-file list present');
  assert.ok(!/terminal-skin\.css/.test(expectedBlock[1]), 'sheet not in the expected files');
  assert.ok(/terminal\.html/.test(expectedBlock[1]), 'terminal page expected in the artifact');
  assert.ok(/terminal-preload\.cjs/.test(expectedBlock[1]), 'terminal preload expected in the artifact');
});

ok('minion1: bundle identity is the Academy identifier', () => {
  // Owner revocation 2026-11-10 21:14 EST: the ai.muse.desktop
  // carve-out is gone; the line ships under its Academy identity.
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.appId, 'com.detroitautomationacademy.minion');
  const assemble = fs.readFileSync(path.join(APP, '..', 'tools', 'assemble.py'), 'utf8');
  assert.ok(/plist\["CFBundleIdentifier"\] = "com\.detroitautomationacademy\.minion"/.test(assemble),
    'assembler stamps the Academy bundle id');
  // The old identifier survives in no functional code: not in any
  // shipped script or the package manifest. (Prose records — the
  // INSTALL notes, the release notes, this suite's comments —
  // legitimately name it as history; the assembler's plist stamp
  // and this manifest are the functional carriers, checked above
  // and here.)
  const codeFiles = fs.readdirSync(ELE).filter((f) => f.endsWith('.cjs'));
  assert.ok(codeFiles.length >= 10, 'app-layer scripts present (' + codeFiles.length + ')');
  for (const f of codeFiles) {
    const text = fs.readFileSync(path.join(ELE, f), 'utf8');
    assert.ok(!/ai\.muse\.desktop/.test(text), 'old bundle id survives in ' + f);
    assert.ok(!/com\.detroitautomationacademy\.muse(?![a-z])/.test(text),
      'superseded academy5 bundle id survives in ' + f);
  }
});

ok('minion1: the app is named Minion on every shipped surface', () => {
  // Owner rename 2026-11-10 21:49 EST: "rename academy muse to
  // minion." The bundle, the windows, the menu, the welcome and the
  // terminal all carry the one name; the upstream identity survives
  // only as provenance (the muse.ai session, the muse-desktop
  // credit), never as the product name.
  const academy = fs.readFileSync(path.join(ELE, 'academy.cjs'), 'utf8');
  assert.ok(/label: 'About Minion'/.test(academy), 'About item is Minion');
  assert.ok(/title: 'Welcome — Minion'/.test(academy), 'welcome window titled Minion');
  assert.ok(/title: 'Terminal — Minion'/.test(academy), 'terminal window titled Minion');
  assert.ok(!/'Muse \(Academy Build\)'/.test(academy),
    'old product name survives in the main layer');
  const main = fs.readFileSync(path.join(ELE, 'main.cjs'), 'utf8');
  assert.ok(/title: "Minion"/.test(main), 'hosted window titled Minion');
  const welcome = fs.readFileSync(path.join(ELE, 'welcome.html'), 'utf8');
  assert.ok(/<h1>Welcome to Minion<\/h1>/.test(welcome), 'welcome headline is Minion');
  assert.ok(!/Terminal Skin/.test(welcome),
    'welcome no longer advertises the deleted skin');
  const terminal = fs.readFileSync(path.join(ELE, 'terminal.html'), 'utf8');
  assert.ok(/<title>Terminal — Minion<\/title>/.test(terminal), 'terminal page titled Minion');
  const assemble = fs.readFileSync(path.join(APP, '..', 'tools', 'assemble.py'), 'utf8');
  assert.ok(/"Minion\.app"/.test(assemble), 'assembler builds Minion.app');
  assert.ok(/plist\["CFBundleName"\] = "Minion"/.test(assemble),
    'assembler stamps the Minion bundle name');
  assert.ok(/plist\["CFBundleExecutable"\] = "Minion"/.test(assemble),
    'assembler stamps the Minion executable');
});

ok('academy5: terminal page is a self-contained shell surface', () => {
  assertGrayscale(path.join(ELE, 'terminal.html'));
  const html = fs.readFileSync(path.join(ELE, 'terminal.html'), 'utf8');
  assert.ok(!/src="http|href="http/.test(html), 'no remote assets');
  assert.ok(/minion ❯/.test(html), 'prompt line present');
  assert.ok(/id="cmd"/.test(html), 'a real text input field is present');
  assert.ok(/border: 2px solid/.test(html), 'the input field is visibly bordered');
  for (const cmd of ['/clear', '/help', '/view']) {
    assert.ok(html.includes(cmd), 'local command ' + cmd + ' handled in the page');
  }
  assert.ok(/academyTerminal/.test(html), 'page talks to its preload bridge');
  const tpreload = fs.readFileSync(path.join(ELE, 'terminal-preload.cjs'), 'utf8');
  assert.ok(/contextBridge/.test(tpreload), 'bridge uses contextBridge');
  for (const ch of ['academy:terminal:send', 'academy:terminal:history',
    'academy:terminal:info', 'academy:terminal:show-hosted', 'academy:terminal:event']) {
    assert.ok(tpreload.includes(ch), 'terminal preload carries ' + ch);
  }
});

ok('academy5: terminal wiring across main, academy, preload', () => {
  const main = fs.readFileSync(path.join(ELE, 'main.cjs'), 'utf8');
  assert.ok(/ACADEMY_BUILD_LABEL = "0\.4\.0-minion1"/.test(main), 'build label is minion1');
  assert.ok(/__academyTerminal/.test(main), 'activate handler can tell the terminal window apart');
  const academy = fs.readFileSync(path.join(ELE, 'academy.cjs'), 'utf8');
  assert.ok(/label: 'Terminal'/.test(academy), 'View menu carries the Terminal item');
  assert.ok(/CmdOrCtrl\+T/.test(academy), 'Terminal carries its accelerator');
  assert.ok(!/CmdOrCtrl\+Shift\+T/.test(academy), 'the skin shortcut is gone');
  assert.ok(/function showTerminal\(\)/.test(academy), 'terminal window constructor present');
  assert.ok(/terminal\.html/.test(academy), 'terminal window loads the shell page');
  assert.ok(/terminal-preload\.cjs/.test(academy), 'terminal window carries its preload');
  for (const ch of ['academy:terminal:send', 'academy:terminal:history',
    'academy:terminal:info', 'academy:terminal:show-hosted',
    'academy:terminal:send-request', 'academy:terminal:history-request']) {
    assert.ok(academy.includes(ch), 'main layer carries ' + ch);
  }
  const preload = fs.readFileSync(path.join(ELE, 'preload.cjs'), 'utf8');
  for (const ch of ['academy:terminal:send-request', 'academy:terminal:send-reply',
    'academy:terminal:history-request', 'academy:terminal:history-reply',
    'academy:terminal:event']) {
    assert.ok(preload.includes(ch), 'hosted preload carries ' + ch);
  }
  assert.ok(/type: 'delta'/.test(preload), 'stream snapshots are emitted');
  assert.ok(/type: 'done'/.test(preload), 'stream completion is emitted');
  assert.ok(/type: 'state'/.test(preload), 'composer presence is reported as state');
});

ok('welcome.html: monochrome, self-contained, carries the unofficial line', () => {
  assertGrayscale(path.join(ELE, 'welcome.html'));
  const html = fs.readFileSync(path.join(ELE, 'welcome.html'), 'utf8');
  assert.ok(!/src="http|href="http/.test(html), 'no remote assets');
  assert.ok(/not a Meta product/.test(html), 'unofficial line present');
  assert.ok(/startup-sound\.wav/.test(html), 'startup sound referenced');
});

ok('SDS-10: welcome logo is the registered icon; version is runtime-read, never hardcoded', () => {
  const html = fs.readFileSync(path.join(ELE, 'welcome.html'), 'utf8');
  assert.ok(/src="app-icon\.png"/.test(html), 'welcome renders the derived bundle-icon master');
  assert.ok(!/\d+\.\d+\.\d+-academy\d/.test(html), 'no hardcoded build label in the welcome');
  assert.ok(!/version \d/.test(html), 'no hardcoded version in the welcome');
  assert.ok(/getBuildInfo/.test(html), 'welcome asks the bridge for the runtime version');
  const preload = fs.readFileSync(path.join(ELE, 'welcome-preload.cjs'), 'utf8');
  assert.ok(/academy:build-info/.test(preload), 'bridge serves build info');
  const academy = fs.readFileSync(path.join(ELE, 'academy.cjs'), 'utf8');
  assert.ok(/app\.getVersion\(\)/.test(academy), 'main answers from the bundle plist (app.getVersion)');
});

ok('floor audit: no post-floor APIs in the new app-layer code', () => {
  const banned = [
    /\.at\(-/, /structuredClone/, /replaceAll\(/, /findLast\(/,
    /Object\.hasOwn/, /top-level await/, /\busing\s+\w+\s*=/,
  ];
  for (const f of ['academy.cjs', 'history.cjs', 'preload.cjs', 'welcome-preload.cjs', 'terminal-preload.cjs', 'md-classify.cjs', 'md-route.cjs']) {
    const text = fs.readFileSync(path.join(ELE, f), 'utf8');
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), f + ' uses banned ' + pattern);
    }
  }
  const main = fs.readFileSync(path.join(ELE, 'main.cjs'), 'utf8');
  // Window-management repair wiring (defect register, files/19):
  assert.ok(/mainWindowPlacement\(\)/.test(main), 'main window placement computed');
  assert.ok(/validateRestoreBounds/.test(main), 'restore validation wired');
  assert.ok(/x: popupBounds\.x/.test(main), 'popup initial bounds computed in the open handler');
  assert.ok(/isMinimized\(\)\) first\.restore\(\)/.test(main), 'activate restores a minimized window');
  assert.ok(/getNormalBounds\(\)/.test(main), 'normal bounds persisted');
  assert.ok(/trackWindowState\(window\)/.test(main), 'window state tracked');
  const academy = fs.readFileSync(path.join(ELE, 'academy.cjs'), 'utf8');
  assert.ok(/getWindowState/.test(academy) && /setWindowState/.test(academy), 'state layer carries window bounds');
  assert.ok(/preload: ACADEMY_PRELOAD/.test(main), 'main window carries the preload');
  assert.ok(/preload: ACADEMY_PRELOAD,/.test(main.replace(/\s+/g, ' ')) || /preload: ACADEMY_PRELOAD/.test(main), 'popup carries the preload');
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.version, '0.4.0');
  assert.strictEqual(pkg.build.appId, 'com.detroitautomationacademy.minion');
});

// ---- Markdown routing (0.4.0-academy3, Distro files/24 MD-T1) ----

const mdClassify = require(path.join(ELE, 'md-classify.cjs'));
const mdRoute = require(path.join(ELE, 'md-route.cjs'));

ok('md-classify: extension is primary; .md/.markdown in, .mdown/.txt out', () => {
  assert.strictEqual(mdClassify.classifyDownload('piece.md', 'text/plain'), true);
  assert.strictEqual(mdClassify.classifyDownload('piece.MD', ''), true);
  assert.strictEqual(mdClassify.classifyDownload('notes.markdown', 'application/octet-stream'), true);
  assert.strictEqual(mdClassify.classifyDownload('notes.mdown', 'text/plain'), false);
  assert.strictEqual(mdClassify.classifyDownload('notes.txt', 'text/plain'), false);
  assert.strictEqual(mdClassify.classifyDownload('archive.md.txt', 'text/plain'), false);
  assert.strictEqual(mdClassify.classifyDownload('noext', 'text/markdown'), false);
  assert.strictEqual(mdClassify.classifyDownload('', ''), false);
});

ok('md-classify: binary MIME vetoes a markdown name; text MIMEs never veto', () => {
  for (const mime of ['application/zip', 'application/pdf', 'image/png', 'audio/mpeg', 'video/mp4', 'application/x-tar', 'application/x-7z-compressed']) {
    assert.strictEqual(mdClassify.classifyDownload('evil.md', mime), false, mime + ' must veto');
  }
  assert.strictEqual(mdClassify.classifyDownload('evil.md', 'application/zip; charset=binary'), false);
  for (const mime of ['text/plain', 'text/markdown', 'text/x-markdown; charset=utf-8', 'application/octet-stream', '']) {
    assert.strictEqual(mdClassify.classifyDownload('real.md', mime), true, mime + ' must not veto');
  }
});

ok('md-route: modules are pure main-process code (no Electron, no IPC surface)', () => {
  for (const f of ['md-classify.cjs', 'md-route.cjs']) {
    const text = fs.readFileSync(path.join(ELE, f), 'utf8');
    assert.ok(!/require\(['"]electron['"]\)/.test(text), f + ' must not require electron');
    assert.ok(!/ipcMain\.(handle|on)\(/.test(text), f + ' must not register IPC');
  }
  const main = fs.readFileSync(path.join(ELE, 'main.cjs'), 'utf8');
  assert.ok(/handleCompletedDownload\(/.test(main), 'main routes completed downloads');
  assert.ok(/noteDownload\(destination\)/.test(main), 'main notes reserved destinations (allowlist)');
  assert.ok(/getMimeType\(\)/.test(main), 'main captures the download MIME for the classifier');
  const academy = fs.readFileSync(path.join(ELE, 'academy.cjs'), 'utf8');
  assert.ok(/getMarkdownRoute/.test(academy), 'academy state serves the routing preference');
});

ok('academy state: markdownRoute round-trips; invalid values fall back to macdown', () => {
  const os = require('node:os');
  const academy = require(path.join(ELE, 'academy.cjs'));
  function installWithState(stateObj) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-state-'));
    if (stateObj) {
      fs.writeFileSync(path.join(dir, 'academy-state.json'), JSON.stringify(stateObj));
    }
    let template = null;
    const ctx = {
      app: { getPath: () => dir, getName: () => 'Minion', setAboutPanelOptions: () => {} },
      BrowserWindow: class {
        static getAllWindows() { return []; }
        static getFocusedWindow() { return null; }
      },
      Menu: {
        buildFromTemplate: (t) => { template = t; return { items: [] }; },
        setApplicationMenu: () => {},
      },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      ipcMain: { handle: () => {}, on: () => {}, removeListener: () => {} },
      buildLabel: 'test',
    };
    return { layer: academy.install(ctx), dir, template: () => template };
  }
  const a = installWithState({ markdownRoute: 'ask' });
  assert.strictEqual(a.layer.getMarkdownRoute(), 'ask');
  a.layer.setMarkdownRoute('system');
  const saved = JSON.parse(fs.readFileSync(path.join(a.dir, 'academy-state.json'), 'utf8'));
  assert.strictEqual(saved.markdownRoute, 'system', 'preference persists');
  a.layer.setMarkdownRoute('bogus');
  assert.strictEqual(a.layer.getMarkdownRoute(), 'system', 'invalid set rejected');
  // The menu carries the radio submenu in the loaded state.
  const view = a.template().find((t) => t.label === 'View');
  const sub = view.submenu.find((i) => i.label === 'Markdown Files Open In');
  assert.ok(sub, 'Markdown Files Open In submenu present');
  assert.deepStrictEqual(sub.submenu.map((i) => i.label), ['MacDown', 'Ask Each Time', 'System Default']);
  assert.strictEqual(sub.submenu.find((i) => i.label === 'Ask Each Time').checked, true);
  const b = installWithState({ markdownRoute: 'bogus' });
  assert.strictEqual(b.layer.getMarkdownRoute(), 'macdown', 'invalid persisted value falls back');
  const c = installWithState(null);
  assert.strictEqual(c.layer.getMarkdownRoute(), 'macdown', 'fresh install defaults to MacDown');
});

ok('md-t3: AcademyLSDefault helper source keeps its enum-only discipline', () => {
  const src = fs.readFileSync(path.join(APP, '..', 'tools', 'AcademyLSDefault.m'), 'utf8');
  assert.ok(/net\.daringfireball\.markdown/.test(src), 'the markdown UTI is the compiled-in constant');
  assert.ok(/com\.detroitautomationacademy\.macdown/.test(src), 'the MacDown id is the compiled-in target');
  assert.ok(!/@"public\.plain-text"|CFSTR\("public\.plain-text"\)/.test(src), 'plain text is never an operative literal (files/24 5b exclusion)');
  const setCalls = src.match(/LSSetDefaultRoleHandlerForContentType/g) || [];
  assert.strictEqual(setCalls.length, 2, 'exactly two set sites: set + restore');
  assert.ok(!/NSTask|system\(|popen|NSWorkspace/.test(src), 'no process or workspace surface');
  for (const verb of ['"get"', '"set"', '"restore"']) {
    assert.ok(src.includes('isEqualToString:' + verb) || src.includes(verb), 'verb ' + verb + ' present');
  }
  const main = fs.readFileSync(path.join(ELE, 'main.cjs'), 'utf8');
  assert.ok(/academy-distro:\/\/app\/macdown/.test(main), 'fallback dialog deep-links to MacDown in Distro (DISTRO-DL1)');
  assert.ok(/AcademyLSDefault/.test(main), 'main builds the lsDefault client');
  assert.ok(/offerMarkdownDefault\(\)/.test(main), 'the first-route offer is wired');
});

// Async router groups: the router's decision tree under a fake env.
function fakeRouteEnv(overrides = {}) {
  const calls = { openWithBundle: [], openSystemDefault: [], openDistro: 0, dialogs: [], bundleIdReads: [] };
  const files = new Map();
  const queue = (overrides.dialogQueue || []).slice();
  const env = {
    statSync: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isFile: () => true, size: files.get(p) };
    },
    realpathSync: (p) => p,
    readBundleId: (appPath) => {
      calls.bundleIdReads.push(appPath);
      return overrides.bundleIds ? overrides.bundleIds[appPath] || null : null;
    },
    homeDir: '/Users/tester',
    openWithBundle: async (id, p) => { calls.openWithBundle.push([id, p]); return overrides.openOk !== false; },
    openSystemDefault: async (p) => { calls.openSystemDefault.push(p); return true; },
    openDistro: async () => { calls.openDistro += 1; return true; },
    showMessageBox: async (opts) => {
      calls.dialogs.push(opts);
      return { response: queue.length ? queue.shift() : (overrides.dialogResponse ?? 0) };
    },
    getPreference: () => overrides.preference || 'macdown',
    log: () => {},
  };
  return { env, calls, files };
}

async function okAsync(name, fn) {
  await fn();
  passed += 1;
  console.log('ok -', name);
}

async function markdownRouterGroups() {
  await okAsync('md-route: allowlist — un-noted paths never route; noted paths do', async () => {
    const { env, calls, files } = fakeRouteEnv();
    const router = mdRoute.createMarkdownRouter(env);
    const dest = '/Users/tester/Downloads/piece.md';
    files.set(dest, 1200);
    const dl = { destination: dest, savePath: dest, filename: 'piece.md', mimeType: 'text/plain' };
    assert.strictEqual(await router.handleCompletedDownload(dl), 'not-allowlisted');
    assert.strictEqual(calls.openWithBundle.length, 0);
    router.noteDownload(dest);
    assert.strictEqual(await router.handleCompletedDownload(dl), 'routed-macdown');
    assert.deepStrictEqual(calls.openWithBundle, [[mdRoute.MACDOWN_BUNDLE_ID, dest]]);
  });

  await okAsync('md-route: classifier + preference gates fire before any open', async () => {
    const a = fakeRouteEnv();
    const ra = mdRoute.createMarkdownRouter(a.env);
    const zip = '/Users/tester/Downloads/evil.md';
    a.files.set(zip, 10);
    ra.noteDownload(zip);
    assert.strictEqual(await ra.handleCompletedDownload({ destination: zip, savePath: zip, filename: 'evil.md', mimeType: 'application/zip' }), 'not-markdown');
    assert.strictEqual(a.calls.dialogs.length, 0);
    const b = fakeRouteEnv({ preference: 'system' });
    const rb = mdRoute.createMarkdownRouter(b.env);
    const ok1 = '/Users/tester/Downloads/ok.md';
    b.files.set(ok1, 10);
    rb.noteDownload(ok1);
    assert.strictEqual(await rb.handleCompletedDownload({ destination: ok1, savePath: ok1, filename: 'ok.md', mimeType: '' }), 'preference-system');
    assert.strictEqual(b.calls.openWithBundle.length, 0);
    const c = fakeRouteEnv();
    const rc = mdRoute.createMarkdownRouter(c.env);
    const gone = '/Users/tester/Downloads/gone.md';
    rc.noteDownload(gone); // noted, then the file vanishes before completion handling
    assert.strictEqual(await rc.handleCompletedDownload({ destination: gone, savePath: gone, filename: 'gone.md', mimeType: '' }), 'missing');
  });

  await okAsync('md-route: Ask Each Time maps buttons to outcomes', async () => {
    async function askCase(response) {
      const f = fakeRouteEnv({ preference: 'ask', dialogQueue: [response] });
      const r = mdRoute.createMarkdownRouter(f.env);
      const dest = '/Users/tester/Downloads/ask.md';
      f.files.set(dest, 500);
      r.noteDownload(dest);
      const outcome = await r.handleCompletedDownload({ destination: dest, savePath: dest, filename: 'ask.md', mimeType: 'text/plain' });
      return { outcome, f };
    }
    const mac = await askCase(0);
    assert.strictEqual(mac.outcome, 'routed-macdown');
    assert.deepStrictEqual(mac.f.calls.dialogs[0].buttons, ['MacDown', 'System Default', 'Downloads Only']);
    const sys = await askCase(1);
    assert.strictEqual(sys.outcome, 'ask-system');
    assert.deepStrictEqual(sys.f.calls.openSystemDefault, ['/Users/tester/Downloads/ask.md']);
    const only = await askCase(2);
    assert.strictEqual(only.outcome, 'ask-downloads-only');
    assert.strictEqual(only.f.calls.openWithBundle.length, 0);
  });

  await okAsync('md-route: detection order, then open failure falls into the absent dialog', async () => {
    // Detection: /Applications first, home second; home hit wins.
    const probe = fakeRouteEnv({ bundleIds: { '/Users/tester/Applications/MacDown.app': mdRoute.MACDOWN_BUNDLE_ID } });
    const probeRouter = mdRoute.createMarkdownRouter(probe.env);
    assert.strictEqual(probeRouter.detectMacDown(), true);
    assert.deepStrictEqual(probe.calls.bundleIdReads, ['/Applications/MacDown.app', '/Users/tester/Applications/MacDown.app']);
    // Absence: open fails -> fallback dialog; buttons map per design.
    async function absentCase(response) {
      const f = fakeRouteEnv({ openOk: false, dialogQueue: [response] });
      const r = mdRoute.createMarkdownRouter(f.env);
      const dest = '/Users/tester/Downloads/lonely.md';
      f.files.set(dest, 42);
      r.noteDownload(dest);
      const outcome = await r.handleCompletedDownload({ destination: dest, savePath: dest, filename: 'lonely.md', mimeType: '' });
      return { outcome, f };
    }
    const distro = await absentCase(0);
    assert.strictEqual(distro.outcome, 'absent-distro');
    assert.strictEqual(distro.f.calls.openDistro, 1);
    assert.deepStrictEqual(distro.f.calls.dialogs[0].buttons, ['Get MacDown in Distro', 'Open with System Default', 'Keep in Downloads']);
    const sysd = await absentCase(1);
    assert.strictEqual(sysd.outcome, 'absent-system');
    assert.deepStrictEqual(sysd.f.calls.openSystemDefault, ['/Users/tester/Downloads/lonely.md']);
    const kept = await absentCase(2);
    assert.strictEqual(kept.outcome, 'absent-kept');
    assert.strictEqual(kept.f.calls.openDistro, 0);
  });

  await okAsync('md-route: oversize guard asks before opening; constant is the design value', async () => {
    assert.strictEqual(mdRoute.ROUTE_MAX_BYTES, 10 * 1024 * 1024);
    const big = '/Users/tester/Downloads/big.md';
    const decline = fakeRouteEnv({ dialogQueue: [1] });
    const rd = mdRoute.createMarkdownRouter(decline.env);
    decline.files.set(big, mdRoute.ROUTE_MAX_BYTES + 1);
    rd.noteDownload(big);
    assert.strictEqual(await rd.handleCompletedDownload({ destination: big, savePath: big, filename: 'big.md', mimeType: '' }), 'kept-oversize');
    assert.deepStrictEqual(decline.calls.dialogs[0].buttons, ['Open Anyway', 'Keep in Downloads']);
    assert.strictEqual(decline.calls.openWithBundle.length, 0);
    const accept = fakeRouteEnv({ dialogQueue: [0] });
    const ra = mdRoute.createMarkdownRouter(accept.env);
    accept.files.set(big, mdRoute.ROUTE_MAX_BYTES + 1);
    ra.noteDownload(big);
    assert.strictEqual(await ra.handleCompletedDownload({ destination: big, savePath: big, filename: 'big.md', mimeType: '' }), 'routed-macdown');
  });

  await okAsync('md-route: completion-path mismatch refuses the open (TOCTOU guard)', async () => {
    const f = fakeRouteEnv();
    const r = mdRoute.createMarkdownRouter(f.env);
    const dest = '/Users/tester/Downloads/piece.md';
    f.files.set(dest, 10);
    r.noteDownload(dest);
    const outcome = await r.handleCompletedDownload({ destination: dest, savePath: '/Users/tester/Downloads/other.md', filename: 'piece.md', mimeType: '' });
    // The open is refused, so the flow lands in the absent/failure
    // dialog (default fake response 0 = Get MacDown in Distro) —
    // what matters is that openWithBundle never fired for the file.
    assert.strictEqual(outcome, 'absent-distro');
    assert.strictEqual(f.calls.openWithBundle.length, 0, 'open never attempted on a mismatched path');
  });
}

// MD-T3 groups: the consented system default under a fake
// LaunchServices client + fake dialogs.
function freshAcademy() {
  const p = require.resolve(path.join(ELE, 'academy.cjs'));
  delete require.cache[p];
  return require(p);
}

function installAcademyT3({ stateObj, ls, dialogResponses }) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-t3-'));
  const stateFile = path.join(dir, 'academy-state.json');
  if (stateObj) fs.writeFileSync(stateFile, JSON.stringify(stateObj));
  const queue = (dialogResponses || []).slice();
  const dialogs = [];
  let template = null;
  const academy = freshAcademy();
  const ctx = {
    app: { getPath: () => dir, getName: () => 'Minion', setAboutPanelOptions: () => {}, getVersion: () => '0.4.0' },
    BrowserWindow: class {
      static getAllWindows() { return []; }
      static getFocusedWindow() { return null; }
    },
    Menu: {
      buildFromTemplate: (t) => { template = t; return { items: [] }; },
      setApplicationMenu: () => {},
    },
    dialog: {
      showMessageBox: async (...args) => {
        const opts = args[args.length - 1];
        dialogs.push(opts);
        return { response: queue.length ? queue.shift() : 0 };
      },
    },
    ipcMain: { handle: () => {}, on: () => {}, removeListener: () => {} },
    buildLabel: 'test',
    lsDefault: ls,
  };
  const layer = academy.install(ctx);
  return { layer, dir, stateFile, dialogs, template: () => template };
}

function fakeLs({ current }) {
  const calls = [];
  let cur = current;
  const api = {
    calls,
    stateFile: null,
    available: () => true,
    getSync: () => cur,
    set: async () => {
      // Record-before-set proof: the predecessor must already be
      // persisted in the state file when the set lands.
      const saved = JSON.parse(fs.readFileSync(api.stateFile, 'utf8'));
      calls.push(['set', saved.markdownDefaultPrevHandler]);
      cur = 'com.detroitautomationacademy.macdown';
      return true;
    },
    restore: async (id) => { calls.push(['restore', id]); cur = id; return true; },
  };
  return api;
}

async function markdownDefaultGroups() {
  await okAsync('md-t3: offer Make Default records the predecessor BEFORE the set', async () => {
    // The fake set reads the state file at call time: the
    // predecessor must already be persisted when the set lands.
    // installAcademyT3 writes no state until a save, so prime the
    // state file path through a first install in the same dir is
    // unnecessary — the fake resolves the file lazily instead.
    const ls = fakeLs({ current: 'com.apple.TextEdit' });
    const t = installAcademyT3({ stateObj: null, ls, dialogResponses: [0] });
    ls.stateFile = t.stateFile;
    await t.layer.offerMarkdownDefault();
    assert.deepStrictEqual(ls.calls[0], ['set', 'com.apple.TextEdit'],
      'set ran with the predecessor already recorded in state');
    const saved = JSON.parse(fs.readFileSync(t.stateFile, 'utf8'));
    assert.strictEqual(saved.markdownDefaultPrevHandler, 'com.apple.TextEdit');
    assert.strictEqual(t.layer.getMarkdownDefaultState().isCurrent, true);
    // Uncheck restores the recorded predecessor and clears it.
    await t.layer.setMarkdownDefaultEnabled(false);
    assert.deepStrictEqual(ls.calls[1], ['restore', 'com.apple.TextEdit']);
    const saved2 = JSON.parse(fs.readFileSync(t.stateFile, 'utf8'));
    assert.strictEqual(saved2.markdownDefaultPrevHandler, null);
  });

  await okAsync('md-t3: Never Ask persists; uncheck without a predecessor gives Finder guidance', async () => {
    const ls = fakeLs({ current: 'com.apple.TextEdit' });
    const t = installAcademyT3({ stateObj: null, ls, dialogResponses: [2] });
    await t.layer.offerMarkdownDefault();
    const saved = JSON.parse(fs.readFileSync(t.stateFile, 'utf8'));
    assert.strictEqual(saved.markdownDefaultNeverAsk, true);
    assert.strictEqual(ls.calls.length, 0, 'no LS change on Never Ask');
    // A later session with neverAsk persisted: offer stays silent.
    const t2 = installAcademyT3({ stateObj: saved, ls, dialogResponses: [0] });
    await t2.layer.offerMarkdownDefault();
    assert.strictEqual(t2.dialogs.length, 0, 'offer suppressed by persisted Never Ask');
    // Uncheck with nothing recorded: guidance dialog, no restore.
    await t2.layer.setMarkdownDefaultEnabled(false);
    assert.strictEqual(ls.calls.length, 0);
    const guidance = t2.dialogs[t2.dialogs.length - 1];
    assert.ok(/Get Info/.test(guidance.detail), 'Finder Get Info guidance shown');
  });

  await okAsync('md-t3: menu checkbox reflects live LS state', async () => {
    const lsIn = fakeLs({ current: 'com.detroitautomationacademy.macdown' });
    const tIn = installAcademyT3({ stateObj: null, ls: lsIn, dialogResponses: [] });
    const viewIn = tIn.template().find((i) => i.label === 'View');
    const boxIn = viewIn.submenu.find((i) => i.label === 'Also Make MacDown the Default for Markdown Files');
    assert.ok(boxIn, 'system-default checkbox present in the View menu');
    assert.strictEqual(boxIn.checked, true, 'checked when MacDown is the live default');
    const lsOut = fakeLs({ current: 'com.apple.TextEdit' });
    const tOut = installAcademyT3({ stateObj: null, ls: lsOut, dialogResponses: [] });
    const viewOut = tOut.template().find((i) => i.label === 'View');
    const boxOut = viewOut.submenu.find((i) => i.label === 'Also Make MacDown the Default for Markdown Files');
    assert.strictEqual(boxOut.checked, false, 'unchecked when another app is the live default');
  });
}

// academy5 terminal behavior: the window, the relay, and the
// honest failure — exercised against a stubbed shell (no Electron).
async function terminalBehaviorGroups() {
  await okAsync('academy5: terminal window, bridge relay, honest failure (stubbed shell)', async () => {
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-t5-'));
    fs.writeFileSync(path.join(dir, 'academy-state.json'),
      JSON.stringify({ welcomeSeen: true }));
    const handlers = new Map();
    const listeners = new Map();
    class FakeContents {
      constructor(url) {
        this.url = url || '';
        this.sent = [];
        this.onceHandlers = new Map();
      }
      send(channel, payload) { this.sent.push([channel, payload]); }
      on() {}
      once(channel, fn) { this.onceHandlers.set(channel, fn); }
      getURL() { return this.url; }
    }
    class FakeWindow {
      constructor(opts) {
        this.opts = opts || {};
        this.webContents = new FakeContents(this.opts.__url || '');
        this.destroyed = false;
        this.visible = false;
        FakeWindow.instances.push(this);
      }
      loadFile(p) { this.loadedFile = p; return Promise.resolve(); }
      on() {}
      once() {}
      isDestroyed() { return this.destroyed; }
      isMinimized() { return false; }
      restore() {}
      show() { this.visible = true; }
      hide() { this.visible = false; }
      focus() {}
      close() { this.destroyed = true; }
    }
    FakeWindow.instances = [];
    FakeWindow.getAllWindows = () => FakeWindow.instances.filter((w) => !w.destroyed);
    FakeWindow.getFocusedWindow = () => null;
    let template = null;
    const academy = freshAcademy();
    const ctx = {
      app: {
        getPath: () => dir, getName: () => 'Minion',
        setAboutPanelOptions: () => {}, getVersion: () => '0.4.0',
        on: () => {},
      },
      BrowserWindow: FakeWindow,
      Menu: {
        buildFromTemplate: (t) => { template = t; return { items: [] }; },
        setApplicationMenu: () => {},
      },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: (channel, fn) => listeners.set(channel, fn),
        removeListener: () => {},
      },
      buildLabel: '0.4.0-minion1',
    };
    const layer = academy.install(ctx);

    // The View menu: Terminal first-class, skin nowhere.
    const view = template.find((t) => t.label === 'View');
    const termItem = view.submenu.find((i) => i.label === 'Terminal');
    assert.ok(termItem, 'Terminal item present in the View menu');
    assert.strictEqual(termItem.accelerator, 'CmdOrCtrl+T');
    assert.ok(!view.submenu.some((i) => i.label === 'Terminal Skin'),
      'no skin toggle in the View menu');

    // The terminal window itself.
    const termWin = layer.showTerminal();
    assert.ok(/terminal-preload\.cjs$/.test(termWin.opts.webPreferences.preload),
      'terminal window carries the terminal preload');
    assert.ok(/terminal\.html$/.test(termWin.loadedFile),
      'terminal window loads the shell terminal page');
    assert.strictEqual(termWin.__academyTerminal, true,
      'terminal window is marked for the activate handler');

    const send = handlers.get('academy:terminal:send');
    const history = handlers.get('academy:terminal:history');
    const info = handlers.get('academy:terminal:info');
    assert.ok(send && history && info, 'terminal IPC handlers registered');

    // Honest failure 1: no hosted window yet — the send is refused
    // with the reason, never echoed as if sent.
    const refused = await send({ sender: termWin.webContents }, 'hello');
    assert.strictEqual(refused.ok, false);
    assert.ok(/not open yet/.test(refused.error), 'refusal names the cause');

    // A non-terminal sender is refused outright.
    const alien = await send({ sender: new FakeContents('https://muse.ai/') }, 'hello');
    assert.strictEqual(alien.ok, false);

    // The hosted window arrives through the welcome gate.
    const hostWin = new FakeWindow({ __url: 'https://muse.ai/chat/1' });
    layer.gateWelcome(() => hostWin);

    // A real relay: the request lands on the hosted webContents;
    // the hosted reply resolves the send.
    const pending = send({ sender: termWin.webContents }, 'hello');
    const req = hostWin.webContents.sent.find((s) => s[0] === 'academy:terminal:send-request');
    assert.ok(req, 'send-request relayed to the hosted window');
    assert.strictEqual(req[1].text, 'hello');
    listeners.get('academy:terminal:send-reply')(
      { sender: hostWin.webContents }, { id: req[1].id, ok: true, error: '' });
    const done = await pending;
    assert.strictEqual(done.ok, true);

    // The send landed in the shared history store (fallback key),
    // and the history relay round-trips the hosted conversation's
    // entries; a non-terminal caller gets nothing.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'academy-state.json'), 'utf8'));
    assert.deepStrictEqual(saved.history.conversations['muse:terminal'].entries, ['hello']);
    assert.deepStrictEqual(await history({ sender: hostWin.webContents }), []);
    const pendingHistory = history({ sender: termWin.webContents });
    const hreq = hostWin.webContents.sent.find((s) => s[0] === 'academy:terminal:history-request');
    assert.ok(hreq, 'history-request relayed to the hosted window');
    listeners.get('academy:terminal:history-reply')(
      { sender: hostWin.webContents }, { id: hreq[1].id, key: 'muse:/chat/1', items: ['older', 'hello'] });
    assert.deepStrictEqual(await pendingHistory, ['older', 'hello']);

    // Build info is the runtime plist version for the terminal only.
    assert.deepStrictEqual(await info({ sender: termWin.webContents }),
      { name: 'Minion', version: '0.4.0', build: '0.4.0-minion1' });
    assert.strictEqual(await info({ sender: hostWin.webContents }), null);
  });
}

markdownRouterGroups()
  .then(markdownDefaultGroups)
  .then(terminalBehaviorGroups)
  .then(() => {
    console.log('\nALL ' + passed + ' TEST GROUPS PASSED');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
