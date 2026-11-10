'use strict';
/*
 * preload.cjs — Muse (Academy Build) v0.4.0-academy.
 *
 * Injected into the hosted muse.ai pages (main window + popups) by
 * the patched main.cjs. Sandboxed: the only module available is
 * `electron` (ipcRenderer). Everything here is defensive — a failure
 * in this file must never break the hosted page; every entry point
 * is wrapped and the whole init is try/caught.
 *
 * Features:
 *  1. Up-arrow sent-message history in the composer (shell-style):
 *     ArrowUp at the start of the composer steps to older sent
 *     messages, ArrowDown steps newer, the in-progress draft is
 *     preserved and restored at the bottom, Escape restores the
 *     draft, and editing a recalled message never mutates the stored
 *     history — the text is recorded only when it is actually sent
 *     (Enter without Shift, or the composer's Send button). History
 *     is per conversation (URL path) and persisted by the main
 *     process in the app's own data directory.
 *  2. Terminal skin support: applies the `academy-terminal` class on
 *     <html> per the persisted preference and injects the skin
 *     stylesheet text served by the main process. The academy2
 *     sheet is whitelist-built (see terminal-skin.css): it can only
 *     style elements carrying a marker class, so this preload tags
 *     exactly three — the composer element (academy-composer), its
 *     shell (academy-composer-shell), and the message stream
 *     container (academy-stream, the scrollable region holding the
 *     conversation). Every skin rule also requires the html class,
 *     so toggling the class off restores the stock UI in full, in
 *     place, with no restart and no residue — the kill-switch is
 *     the class itself. Enter sends / Shift+Enter newline is the
 *     composer's own behavior and is not overridden.
 */

var ipcRenderer = null;
try {
  ipcRenderer = require('electron').ipcRenderer;
} catch (error) {
  ipcRenderer = null;
}

// BEGIN history-nav
function createNavigator(entries) {
  var items = Array.isArray(entries) ? entries.slice() : [];
  var index = items.length; // one past the newest == the draft line
  var draft = null;

  function refresh(nextEntries) {
    items = Array.isArray(nextEntries) ? nextEntries.slice() : [];
    index = items.length;
    draft = null;
  }

  function older(currentText) {
    if (index === items.length) draft = typeof currentText === 'string' ? currentText : '';
    if (index <= 0) return null;
    index -= 1;
    return items[index];
  }

  function newer() {
    if (index >= items.length) return null;
    index += 1;
    if (index === items.length) return draft === null ? '' : draft;
    return items[index];
  }

  function isNavigating() {
    return index < items.length;
  }

  function notifySent() {
    index = items.length;
    draft = null;
  }

  function escape() {
    if (!isNavigating()) return null;
    index = items.length;
    var restored = draft === null ? '' : draft;
    draft = null;
    return restored;
  }

  return {
    refresh: refresh,
    older: older,
    newer: newer,
    isNavigating: isNavigating,
    notifySent: notifySent,
    escape: escape,
  };
}
// END history-nav

function conversationKey() {
  try {
    return 'muse:' + window.location.pathname;
  } catch (error) {
    return 'muse:/';
  }
}

function isVisible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  var rect = el.getBoundingClientRect();
  if (!rect || rect.width < 40 || rect.height < 8) return false;
  var style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

// The composer is the page's message input: a textarea or an editable
// textbox. Chat composers sit low in the document, so among visible
// candidates the one with the greatest bottom edge wins; elements in
// the main landmark / a form get a bonus.
function findComposer() {
  var candidates = document.querySelectorAll(
    'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
  );
  var best = null;
  var bestScore = -Infinity;
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    if (!isVisible(el)) continue;
    var rect = el.getBoundingClientRect();
    var score = rect.bottom;
    if (el.closest && el.closest('main, form')) score += 10000;
    if (el.tagName === 'TEXTAREA') score += 100;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function isEditable(el) {
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
}

function composerFromEvent(event) {
  var target = event.target;
  if (!target || !target.closest) return null;
  if (isEditable(target) && target.closest('[data-academy-composer-root], body')) {
    // The event target itself may be an inner node of a contenteditable.
    var editable = target.isContentEditable
      ? target.closest('[contenteditable]')
      : target;
    return editable || target;
  }
  return null;
}

function getText(el) {
  if (!el) return '';
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
  return (el.innerText || el.textContent || '').replace(/\n$/, '');
}

function setText(el, text) {
  if (!el) return;
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    var proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    try { el.setSelectionRange(text.length, text.length); } catch (error) { /* noop */ }
    return;
  }
  // contenteditable: select the whole editable and insert as typed
  // text so the page's own input pipeline sees a normal edit.
  var selection = window.getSelection();
  if (selection) {
    var range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  var done = false;
  try {
    done = document.execCommand('insertText', false, text);
  } catch (error) {
    done = false;
  }
  if (!done) {
    el.textContent = text;
    el.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

function caretAtStart(el) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return el.selectionStart === 0 && el.selectionEnd === 0;
  }
  var selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  var range = selection.getRangeAt(0);
  if (!range.collapsed) return false;
  var probe = range.cloneRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}

function caretAtEnd(el) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  }
  var selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  var range = selection.getRangeAt(0);
  if (!range.collapsed) return false;
  var probe = range.cloneRange();
  probe.selectNodeContents(el);
  probe.setStart(range.endContainer, range.endOffset);
  return probe.toString().trim().length === 0;
}

function init() {
  if (!ipcRenderer) return;
  var key = conversationKey();
  var navigator = createNavigator([]);
  var composer = null;

  function refreshEntries() {
    ipcRenderer.invoke('academy:history:list', key).then(function (entries) {
      navigator.refresh(entries || []);
    }).catch(function () { /* history is best-effort */ });
  }
  refreshEntries();

  function recordSend(text) {
    var value = (text || '').trim();
    if (!value) return;
    navigator.notifySent();
    ipcRenderer.invoke('academy:history:add', key, value).then(function (entries) {
      navigator.refresh(entries || []);
    }).catch(function () { /* best-effort */ });
  }

  var streamEl = null;

  // The message stream is the scrollable region holding the
  // conversation. The composer may sit inside it or below it as a
  // sibling, so look in two places: the composer's own scrollable
  // ancestor chain, then the tallest scrollable element in the
  // main landmark. Found or not, this only ever tags ONE element
  // with a marker class — the skin styles nothing else.
  function findStream() {
    try {
      var el = composer;
      while (el && el.parentElement && el.parentElement !== document.body) {
        el = el.parentElement;
        var style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.clientHeight >= 120) {
          return el;
        }
      }
    } catch (error) { /* fall through to the landmark search */ }
    try {
      var root = document.querySelector('main') || document.body;
      var nodes = root.querySelectorAll('div, section');
      var best = null;
      var bestHeight = 119;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var st = window.getComputedStyle(node);
        if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && node.clientHeight > bestHeight) {
          best = node;
          bestHeight = node.clientHeight;
        }
      }
      return best;
    } catch (error) {
      return null;
    }
  }

  function trackComposer() {
    var found = findComposer();
    if (found && found !== composer) {
      if (composer && composer.classList) composer.classList.remove('academy-composer');
      composer = found;
      if (composer.classList) composer.classList.add('academy-composer');
      var shell = composer.closest ? (composer.closest('form') || composer.parentElement) : null;
      if (shell && shell.classList) shell.classList.add('academy-composer-shell');
    }
    if (composer) {
      var stream = findStream();
      if (stream !== streamEl) {
        if (streamEl && streamEl.classList) streamEl.classList.remove('academy-stream');
        streamEl = stream;
        if (streamEl && streamEl.classList) streamEl.classList.add('academy-stream');
      }
    }
    return composer;
  }
  trackComposer();
  try {
    var observer = new MutationObserver(function () { trackComposer(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (error) { /* no observer: discovery at event time still works */ }

  document.addEventListener('keydown', function (event) {
    try {
      var el = composerFromEvent(event) || (document.activeElement && isEditable(document.activeElement) ? document.activeElement : null);
      if (!el) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing) {
        // The page performs the send; we only record the text.
        recordSend(getText(el));
        return;
      }
      if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        if (!caretAtStart(el)) return;
        var older = navigator.older(getText(el));
        if (older === null) return;
        event.preventDefault();
        setText(el, older);
        return;
      }
      if (event.key === 'ArrowDown' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        if (!navigator.isNavigating() || !caretAtEnd(el)) return;
        var newer = navigator.newer();
        if (newer === null) return;
        event.preventDefault();
        setText(el, newer);
        return;
      }
      if (event.key === 'Escape' && navigator.isNavigating()) {
        var restored = navigator.escape();
        if (restored === null) return;
        event.preventDefault();
        setText(el, restored);
      }
    } catch (error) { /* never break the page */ }
  }, true);

  document.addEventListener('click', function (event) {
    try {
      var target = event.target;
      if (!target || !target.closest) return;
      var button = target.closest('button, [role="button"]');
      if (!button) return;
      var label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').toLowerCase();
      if (label.indexOf('send') === -1) return;
      var el = trackComposer();
      if (el) recordSend(getText(el));
    } catch (error) { /* never break the page */ }
  }, true);

  // SPA navigation: a new conversation path means a fresh history.
  var lastPath = window.location.pathname;
  window.setInterval(function () {
    try {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        key = conversationKey();
        navigator = createNavigator([]);
        composer = null;
        refreshEntries();
        trackComposer();
      }
    } catch (error) { /* noop */ }
  }, 1000);

  // Terminal skin: stylesheet once (rules are class-gated), class per
  // the persisted preference, kept live via the apply broadcast.
  function applySkin(on) {
    try {
      document.documentElement.classList.toggle('academy-terminal', !!on);
    } catch (error) { /* noop */ }
  }
  ipcRenderer.invoke('academy:skin:css').then(function (css) {
    if (!css || document.getElementById('academy-terminal-style')) return;
    var style = document.createElement('style');
    style.id = 'academy-terminal-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }).catch(function () { /* skin is optional */ });
  ipcRenderer.invoke('academy:skin:get').then(applySkin).catch(function () { /* noop */ });
  ipcRenderer.on('academy:skin:apply', function (_event, on) { applySkin(on); });
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { try { init(); } catch (error) { /* noop */ } });
  } else {
    init();
  }
} catch (error) { /* the hosted page must never see a preload failure */ }
