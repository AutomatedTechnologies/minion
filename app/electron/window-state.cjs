'use strict';
/*
 * window-state.cjs — Muse (Academy Build) v0.4.0-academy.
 *
 * Pure geometry for the window-management repair (owner escalation
 * 2026-11-10; defect register in files/19). No Electron imports —
 * the main process passes display work areas in, so every rule is
 * unit-testable in plain Node.
 *
 * Rules:
 *  - Cascade: when windows already exist, a new window opens offset
 *    from the most recent one instead of exactly on top of it
 *    (fix-spec rule: never stack invisibly on the active window).
 *  - Restore validation: saved bounds are honored only if the rect
 *    still lands substantially on a current display — a rect saved
 *    against a since-removed monitor is discarded, never restored
 *    into the void (the partially-off-screen spawn defect).
 *  - Placement: a wanted rect is clamped to 100% inside the work
 *    area of the display it matches (window-law.cjs clamp).
 */

var CASCADE_STEP = 28;
var CASCADE_WRAP = 8; // after 8 offsets, wrap back toward the origin

function cascadeOffset(existingCount) {
  var n = Math.max(0, Math.floor(existingCount) || 0) % CASCADE_WRAP;
  return { dx: CASCADE_STEP * n, dy: CASCADE_STEP * n };
}

function intersectionArea(a, b) {
  var x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  var y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y;
}

// fraction: how much of rect lands inside area (0..1)
function visibleFraction(rect, area) {
  var total = rect.width * rect.height;
  if (total <= 0) return 0;
  return intersectionArea(rect, area) / total;
}

function isSaneBounds(b) {
  return !!b &&
    typeof b.x === 'number' && typeof b.y === 'number' &&
    typeof b.width === 'number' && typeof b.height === 'number' &&
    isFinite(b.x) && isFinite(b.y) && isFinite(b.width) && isFinite(b.height) &&
    b.width >= 200 && b.height >= 150;
}

// workAreas: [{x,y,width,height}] for every current display.
// Returns the saved rect if it is sane and at least half of it is
// visible on some current display; otherwise null (caller falls
// back to a default centered placement).
function validateRestoreBounds(saved, workAreas) {
  if (!isSaneBounds(saved)) return null;
  if (!Array.isArray(workAreas) || workAreas.length === 0) return null;
  for (var i = 0; i < workAreas.length; i++) {
    if (visibleFraction(saved, workAreas[i]) >= 0.5) {
      return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    }
  }
  return null;
}

// The rect a new window should open with: start from a base rect
// (restored bounds, or the default size at the primary work area's
// origin), cascade it past existing windows, and let the caller's
// clamp pull the result fully on-screen.
function placementFor(base, existingCount) {
  var offset = cascadeOffset(existingCount);
  return {
    x: base.x + offset.dx,
    y: base.y + offset.dy,
    width: base.width,
    height: base.height,
  };
}

module.exports = {
  cascadeOffset: cascadeOffset,
  visibleFraction: visibleFraction,
  isSaneBounds: isSaneBounds,
  validateRestoreBounds: validateRestoreBounds,
  placementFor: placementFor,
};
