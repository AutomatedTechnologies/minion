'use strict';
/*
 * avatar-governor.cjs — Minion 0.4.3, main-process requireable copy.
 *
 * The avatar governor: the decision core of the 0.4.3 performance
 * fix (Distro files/39; estate review ER-15). The hosted page this
 * shell carries renders the owner's avatar as a continuously
 * looping animation inside the Electron renderer. On the 10.13 Air
 * (HD Graphics 4000) that loop is decoded and composited without
 * pause — the owner's 2026-11-12 Activity Monitor baseline charged
 * the renderer + GPU pair 92.7% of one thread sustained against the
 * Tachometer budget table v1 row `minion-avatar` (<= 10% sustained,
 * <= 50% peak, Distro files/36). Chromium's background throttling
 * does not stop media decode, and the loop runs at full rate while
 * the window is merely unfocused, occluded, or left idle on screen.
 *
 * The governor removes the cost by construction, in the shell, with
 * no change to the avatar's appearance while the app is in use:
 * animation is PAUSED whenever any of these holds —
 *   hidden:    the page is not visible (minimized, hidden, occluded
 *              to a hidden page state);
 *   unfocused: the window is not the frontmost window;
 *   idle:      the window is visible and focused, but neither the
 *              owner (pointer / key / wheel / touch) nor the page
 *              content (DOM mutations — a streaming reply counts as
 *              activity) has been active for the idle window.
 * Any signal of use resumes instantly, and only media the governor
 * itself paused is ever resumed.
 *
 * This module is the pure decision state machine: it owns no DOM,
 * no timers, and no Electron. The preload adapter (preload.cjs,
 * feature 3) feeds it signals and applies its verdicts to the page
 * (a stylesheet that pauses CSS animations + pause()/play() on the
 * page's video elements). The state machine is mirrored inline in
 * preload.cjs between the avatar-governor markers — a sandboxed
 * preload cannot require app files — and the test suite asserts
 * the mirror is byte-identical to the block below.
 *
 * Electron 22 / Node 16 APIs only. No dependencies.
 */

// BEGIN avatar-governor
var AVATAR_GOVERNOR_IDLE_MS = 45000;

function createAvatarGovernor(options) {
  var idleMs = (options && options.idleMs) || AVATAR_GOVERNOR_IDLE_MS;
  var onPause = (options && options.onPause) || function () {};
  var onResume = (options && options.onResume) || function () {};
  var hidden = false;
  var focused = true;
  var startedAt = 0;
  var lastActivityAt = 0;
  var pausedReason = null; // null | 'hidden' | 'unfocused' | 'idle'

  function reasonAt(now) {
    if (hidden) return 'hidden';
    if (!focused) return 'unfocused';
    var since = lastActivityAt || startedAt;
    if (now - since >= idleMs) return 'idle';
    return null;
  }

  function evaluate(now) {
    var reason = reasonAt(now);
    if (reason && !pausedReason) {
      pausedReason = reason;
      onPause(reason);
    } else if (!reason && pausedReason) {
      pausedReason = null;
      onResume();
    } else if (reason && reason !== pausedReason) {
      // Still paused, harder reason: track it so a partial signal
      // change (e.g. focus returns while hidden) cannot resume.
      pausedReason = reason;
    }
    return pausedReason;
  }

  return {
    start: function (now) {
      startedAt = now;
      lastActivityAt = now;
      return evaluate(now);
    },
    setHidden: function (value, now) {
      hidden = !!value;
      // Becoming visible restarts the idle window: the owner just
      // brought the app forward, which is itself use.
      if (!hidden) lastActivityAt = now;
      return evaluate(now);
    },
    setFocused: function (value, now) {
      focused = !!value;
      if (focused) lastActivityAt = now;
      return evaluate(now);
    },
    activity: function (now) {
      lastActivityAt = now;
      return evaluate(now);
    },
    poll: function (now) {
      return evaluate(now);
    },
    reason: function () {
      return pausedReason;
    },
    isPaused: function () {
      return !!pausedReason;
    },
  };
}
// END avatar-governor

module.exports = { createAvatarGovernor, AVATAR_GOVERNOR_IDLE_MS };
