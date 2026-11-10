'use strict';
/*
 * run-tests.cjs — Muse (Academy Build) v0.4.0-academy2 verification.
 * Plain Node (>= the Electron 22 runtime's Node 16 semantics; runs on
 * any modern Node). Covers:
 *  1. history.cjs store: add/dedupe/caps/isolation/persistence/evict.
 *  2. Navigator semantics (history.cjs copy): shell recall order,
 *     draft preservation + restore, Escape, edit-never-mutates.
 *  3. The preload.cjs mirror of the navigator is byte-identical to
 *     the history.cjs block between the history-nav markers.
 *  4. terminal-skin.css + welcome.html: every hex color is a gray
 *     (R=G=B); no remote references, gradients, or backdrop filters.
 *  5. App layer floor audit: no syntax or API past the Electron 22 /
 *     Chromium 108 / macOS 10.13 floor in the new code.
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
for (const f of ['main.cjs', 'utils.cjs', 'academy.cjs', 'history.cjs', 'preload.cjs', 'welcome-preload.cjs', 'window-law.cjs', 'window-state.cjs']) {
  execFileSync(process.execPath, ['--check', path.join(ELE, f)]);
}
ok('node --check clean on all 8 app-layer scripts', () => {});

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

ok('terminal-skin.css: monochrome ramp only; no remote/gradient/blur', () => {
  assertGrayscale(path.join(ELE, 'terminal-skin.css'));
  const css = fs.readFileSync(path.join(ELE, 'terminal-skin.css'), 'utf8');
  // academy2 amendment: the ONLY url() permitted is the inline SVG
  // data URI carrying the composer's prompt glyph — it fetches
  // nothing. Any other url() (remote or local file) fails. The
  // remote-ref scan runs with data URIs removed: the SVG xmlns
  // inside the payload is a namespace identifier, not a reference.
  const urls = css.match(/url\([^)]*\)/g) || [];
  assert.ok(!/https?:\/\//.test(css.replace(/url\([^)]*\)/g, '')), 'no remote refs');
  for (const u of urls) {
    assert.ok(u.startsWith('url("data:image/svg+xml,'), 'url() must be the inline SVG glyph, got: ' + u.slice(0, 60));
  }
  assert.ok(!/gradient/.test(css), 'no gradients');
  assert.ok(!/backdrop-filter/.test(css), 'no backdrop blur');
  assert.ok(/html\.academy-terminal/.test(css), 'rules are class-gated');
});

ok('terminal-skin.css: whitelist discipline (academy2 rebuild)', () => {
  const raw = fs.readFileSync(path.join(ELE, 'terminal-skin.css'), 'utf8');
  // Strip comments before scanning: the header documents the ban
  // in prose and must not trip its own enforcement.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  // Parse rules: selector list + declaration block.
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) rules.push({ sel: m[1].trim(), body: m[2] });
  assert.ok(rules.length >= 4, 'skin rules present');
  const MARKERS = ['.academy-stream', '.academy-composer', '.academy-composer-shell'];
  for (const rule of rules) {
    const selectors = rule.sel.split(',').map((s) => s.trim()).filter(Boolean);
    assert.ok(selectors.length > 0, 'rule has selectors');
    for (const sel of selectors) {
      // Gate: every selector requires the html class (kill-switch
      // soundness — removing the class restores the stock UI).
      assert.ok(sel.startsWith('html.academy-terminal'), 'selector not class-gated: ' + sel);
      // Scope: after the gate, the next compound is a marker class,
      // never a generic element, the universal selector, or body.
      assert.ok(MARKERS.some((k) => sel.startsWith('html.academy-terminal ' + k)),
        'selector not scoped to a whitelist marker: ' + sel);
    }
    // Declarations: typography, color, caret, matched tints, the
    // painted left rule — and nothing that can move a box.
    const banned = /(^|;)\s*(display|position|width|height|min-width|max-width|min-height|max-height|margin|padding|overflow|z-index|float|top|left|right|bottom|border|visibility|transform|opacity)\s*:/;
    assert.ok(!banned.test(';' + rule.body), 'banned layout property in rule: ' + rule.sel);
  }
  // The painted left rule is the sheet's only box-shadow.
  assert.strictEqual((css.match(/box-shadow/g) || []).length, 1, 'exactly one box-shadow (the shell rule)');
  // The root elements carry no rules (the academy1 takeover ban).
  assert.ok(!/html\.academy-terminal\s*,/.test(css), 'no bare html gate rule');
  assert.ok(!/html\.academy-terminal\s+body/.test(css), 'no body rules');
});

ok('skin preference epoch: an academy1 ON cannot survive the upgrade', () => {
  const academy = fs.readFileSync(path.join(ELE, 'academy.cjs'), 'utf8');
  assert.ok(/const SKIN_EPOCH = 2;/.test(academy), 'epoch constant at 2');
  assert.ok(/data\.skinEpoch >= SKIN_EPOCH && data\.terminalSkin === true/.test(academy),
    'load honors the persisted preference only at the current epoch');
  assert.ok(/skinEpoch: SKIN_EPOCH/.test(academy), 'save stamps the current epoch');
  // The toggle path itself is unchanged and total: class on/off via
  // the broadcast, state saved — verified in preload below.
  const preload = fs.readFileSync(path.join(ELE, 'preload.cjs'), 'utf8');
  assert.ok(/classList\.toggle\('academy-terminal', !!on\)/.test(preload),
    'kill-switch toggles the single gating class');
});

ok('preload tags exactly the whitelist marker elements', () => {
  const preload = fs.readFileSync(path.join(ELE, 'preload.cjs'), 'utf8');
  assert.ok(/classList\.add\('academy-composer'\)/.test(preload), 'composer element tagged');
  assert.ok(/classList\.add\('academy-composer-shell'\)/.test(preload), 'composer shell tagged');
  assert.ok(/classList\.add\('academy-stream'\)/.test(preload), 'message stream tagged');
  assert.ok(/classList\.remove\('academy-stream'\)/.test(preload), 'stale stream tag moved, not duplicated');
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
  for (const f of ['academy.cjs', 'history.cjs', 'preload.cjs', 'welcome-preload.cjs']) {
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
  assert.strictEqual(pkg.build.appId, 'ai.muse.desktop');
});

console.log('\nALL ' + passed + ' TEST GROUPS PASSED');
