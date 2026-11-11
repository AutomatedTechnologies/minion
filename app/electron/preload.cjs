'use strict';
/*
 * preload.cjs — Minion 0.4.1.
 *
 * Injected into the hosted pages (main window + popups) by
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
 *  2. Terminal bridge (0.4.0-academy5): the shell's Terminal
 *     window is a front-end over THIS hosted session. On a
 *     send-request from the main process, the message is driven
 *     through the page's own composer (setText + the page's Send
 *     button, Enter as fallback) — the page performs the real send
 *     on the real authenticated session — and the reply is
 *     observed from the message stream as it renders, reported
 *     back as snapshot deltas (the full response text at ~250 ms
 *     poll pace, not an API token stream). With no composer on the
 *     page (signed out, still loading) the send is refused with
 *     the reason; nothing is ever faked locally. The bridge also
 *     answers history requests with this conversation's stored
 *     history and reports composer presence as session state.
 *     The terminal SKIN this bridge replaces was deleted in
 *     academy5 (owner rejection, files/19 section 10): the marker
 *     classes it needed (academy-composer / -shell / -stream) are
 *     no longer tagged — the stream element is still tracked, as
 *     the bridge's observation surface, but carries no class.
 *     Enter sends / Shift+Enter newline is the composer's own
 *     behavior and is not overridden.
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
    return 'minion:' + window.location.pathname;
  } catch (error) {
    return 'minion:/';
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
  // main landmark. The terminal bridge observes this element's
  // rendered text to stream replies back to the Terminal window.
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
    if (found) composer = found;
    if (composer) {
      var stream = findStream();
      if (stream) streamEl = stream;
    }
    reportHostState();
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
        hostState = null;
        refreshEntries();
        trackComposer();
      }
    } catch (error) { /* noop */ }
  }, 1000);

  // ---- Terminal bridge (0.4.0-academy5, files/19 section 10) ----
  var hostState = null;
  function reportHostState() {
    var present = !!composer;
    if (hostState === present) return;
    hostState = present;
    try {
      ipcRenderer.send('academy:terminal:event', { type: 'state', composer: present });
    } catch (error) { /* best-effort */ }
  }
  window.setTimeout(reportHostState, 1500);

  var termActive = null;
  function streamText() {
    var s = streamEl || findStream();
    if (!s) return '';
    try {
      return s.innerText || s.textContent || '';
    } catch (error) {
      return '';
    }
  }
  function responseText() {
    var full = streamText();
    if (!termActive) return '';
    var base = termActive.baseline || '';
    var out = full;
    if (base && full.indexOf(base) === 0) out = full.slice(base.length);
    out = out.replace(/^\s+/, '');
    var sent = termActive.sentText || '';
    if (sent && out.indexOf(sent) === 0) {
      out = out.slice(sent.length).replace(/^\s+/, '');
    }
    return out;
  }
  function finishStream(note) {
    if (!termActive) return;
    var id = termActive.id;
    var finalText = responseText();
    if (termActive.timer) window.clearTimeout(termActive.timer);
    termActive = null;
    try {
      ipcRenderer.send('academy:terminal:event', {
        type: 'done', id: id, text: finalText, note: note || '',
      });
    } catch (error) { /* noop */ }
  }
  function pollStream() {
    if (!termActive) return;
    var now = Date.now();
    var text = responseText();
    if (text !== termActive.lastText) {
      termActive.lastText = text;
      termActive.lastChange = now;
      try {
        ipcRenderer.send('academy:terminal:event', {
          type: 'delta', id: termActive.id, text: text,
        });
      } catch (error) { /* noop */ }
    }
    var capped = now - termActive.startedAt >= 180000;
    var settled = now - termActive.lastChange >= 1600 &&
      now - termActive.startedAt >= 1200 && !!termActive.lastText;
    if (capped || settled) {
      finishStream(capped ? 'time cap reached' : '');
      return;
    }
    termActive.timer = window.setTimeout(pollStream, 250);
  }
  function findSendButton() {
    var scopes = [];
    try {
      var form = composer && composer.closest ? composer.closest('form') : null;
      if (form) scopes.push(form);
    } catch (error) { /* noop */ }
    scopes.push(document);
    for (var s = 0; s < scopes.length; s++) {
      var buttons = scopes[s].querySelectorAll('button, [role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        var label = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
        if (label.indexOf('send') === -1) continue;
        if (b.disabled) continue;
        var rect = b.getBoundingClientRect();
        if (!rect || rect.width < 12 || rect.height < 12) continue;
        return b;
      }
    }
    return null;
  }
  function dispatchEnter(el) {
    try {
      var opts = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      };
      el.dispatchEvent(new window.KeyboardEvent('keydown', opts));
      el.dispatchEvent(new window.KeyboardEvent('keyup', opts));
    } catch (error) { /* noop */ }
  }

  ipcRenderer.on('academy:terminal:send-request', function (_event, payload) {
    var id = payload && payload.id;
    var text = payload && typeof payload.text === 'string' ? payload.text : '';
    function reply(ok, error) {
      try {
        ipcRenderer.send('academy:terminal:send-reply', {
          id: id, ok: ok, error: error || '',
        });
      } catch (e) { /* noop */ }
    }
    try {
      var el = trackComposer();
      if (!el) {
        reply(false, 'No message box on the hosted page — sign in to Minion in the main window first.');
        return;
      }
      if (termActive) finishStream('superseded by a newer send');
      var baseline = streamText();
      setText(el, text);
      var button = findSendButton();
      if (button) button.click();
      else dispatchEnter(el);
      termActive = {
        id: id,
        baseline: baseline,
        sentText: text.trim(),
        lastText: '',
        lastChange: Date.now(),
        startedAt: Date.now(),
        timer: null,
      };
      termActive.timer = window.setTimeout(pollStream, 250);
      window.setTimeout(function () {
        // Verify the page actually took the send: the composer
        // cleared, or the stream moved. Otherwise say so, plainly.
        var stillThere = getText(el).trim() === text.trim();
        var moved = streamText() !== baseline;
        if (stillThere && !moved) {
          if (termActive && termActive.id === id) {
            if (termActive.timer) window.clearTimeout(termActive.timer);
            termActive = null;
          }
          reply(false, 'The hosted page did not accept the message — the text is still sitting in its message box.');
        } else {
          reply(true, '');
        }
      }, 800);
    } catch (error) {
      reply(false, 'The terminal bridge hit an error driving the hosted page.');
    }
  });

  ipcRenderer.on('academy:terminal:history-request', function (_event, payload) {
    var id = payload && payload.id;
    function answer(items) {
      try {
        ipcRenderer.send('academy:terminal:history-reply', {
          id: id, key: key, items: items || [],
        });
      } catch (error) { /* noop */ }
    }
    ipcRenderer.invoke('academy:history:list', key)
      .then(answer)
      .catch(function () { answer([]); });
  });
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { try { init(); } catch (error) { /* noop */ } });
  } else {
    init();
  }
} catch (error) { /* the hosted page must never see a preload failure */ }
