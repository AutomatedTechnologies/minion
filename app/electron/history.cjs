'use strict';
/*
 * history.cjs — Minion 0.4.1, main process.
 *
 * Sent-message history for the composer: shell-style up-arrow recall,
 * persisted per conversation in the app's own data directory.
 *
 * Two pieces:
 *  - createHistoryStore: the persistent store. One entry list per
 *    conversation key, oldest first. Caps keep the file bounded.
 *    A send appends; consecutive duplicates collapse (a re-sent line
 *    is one line of history, as in a shell).
 *  - createNavigator: the recall state machine. It works on a
 *    SNAPSHOT of one conversation's entries: recalling and editing a
 *    line never mutates the store — the edited text enters history
 *    only when it is actually sent (store.add on send). The
 *    in-progress draft is captured on the first step up and restored
 *    when navigation returns to the bottom.
 *
 * The navigator is mirrored inline in preload.cjs (a sandboxed
 * preload cannot require app files). The mirror is delimited by
 * BEGIN/END history-nav markers and the test suite asserts the two
 * implementations are behaviorally identical.
 *
 * Electron 22 / Node 16 APIs only. No dependencies.
 */

var DEFAULT_CAP_PER_CONVERSATION = 200;
var DEFAULT_CAP_CONVERSATIONS = 50;

function cleanText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

function createHistoryStore(options) {
  var capPer = (options && options.capPerConversation) || DEFAULT_CAP_PER_CONVERSATION;
  var capConvs = (options && options.capConversations) || DEFAULT_CAP_CONVERSATIONS;
  // key -> { entries: [oldest..newest], updatedAt: number }
  var conversations = {};
  var clock = 0;

  function list(key) {
    var conv = conversations[key];
    return conv ? conv.entries.slice() : [];
  }

  function add(key, text) {
    var value = cleanText(text);
    if (!key || !value) return list(key);
    var conv = conversations[key];
    if (!conv) {
      conv = conversations[key] = { entries: [], updatedAt: 0 };
    }
    if (conv.entries[conv.entries.length - 1] !== value) {
      conv.entries.push(value);
      if (conv.entries.length > capPer) {
        conv.entries.splice(0, conv.entries.length - capPer);
      }
    }
    conv.updatedAt = ++clock;
    // Bound the conversation count: evict least-recently-updated.
    var keys = Object.keys(conversations);
    if (keys.length > capConvs) {
      keys.sort(function (a, b) { return conversations[a].updatedAt - conversations[b].updatedAt; });
      for (var i = 0; i < keys.length - capConvs; i++) delete conversations[keys[i]];
    }
    return list(key);
  }

  function clear() {
    conversations = {};
  }

  function toJSON() {
    var out = {};
    Object.keys(conversations).forEach(function (key) {
      out[key] = {
        entries: conversations[key].entries.slice(),
        updatedAt: conversations[key].updatedAt,
      };
    });
    return { version: 1, conversations: out };
  }

  function load(data) {
    conversations = {};
    clock = 0;
    if (!data || typeof data !== 'object' || !data.conversations) return;
    Object.keys(data.conversations).forEach(function (key) {
      var conv = data.conversations[key];
      if (!conv || !Array.isArray(conv.entries)) return;
      var entries = conv.entries.filter(function (e) { return typeof e === 'string' && e.trim(); });
      if (entries.length > capPer) entries = entries.slice(entries.length - capPer);
      if (!entries.length) return;
      conversations[key] = {
        entries: entries,
        updatedAt: typeof conv.updatedAt === 'number' ? conv.updatedAt : 0,
      };
      if (conversations[key].updatedAt > clock) clock = conversations[key].updatedAt;
    });
  }

  return { list: list, add: add, clear: clear, toJSON: toJSON, load: load };
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

module.exports = {
  createHistoryStore: createHistoryStore,
  createNavigator: createNavigator,
};
