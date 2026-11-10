'use strict';
/*
 * WindowLaw — Muse (Academy Build) v0.4.0-academy, main process.
 * Fixes P1 (originating defect, 2026-11-08): browser windows stacking
 * partially off-screen and overlapping the active window.
 *
 * Law:
 *  1. One main window. Browser tasks NEVER create free OS windows.
 *     They register as panes in BrowserPaneStack inside the main window.
 *  2. Every pane rectangle is clamped so its intersection with the
 *     display visible frame is 100% of the pane. A pane that would
 *     open off-screen is re-centered and the event is logged.
 *  3. Panes tile, they do not cascade: slot = index in stack order.
 * Electron 22.3.27 / Chromium 108 APIs only. No nodeIntegration change.
 */

function clampRectToVisibleFrame(rect, visible) {
  const w = Math.min(rect.width, visible.width);
  const h = Math.min(rect.height, visible.height);
  let x = rect.x;
  let y = rect.y;
  if (x < visible.x) x = visible.x;
  if (y < visible.y) y = visible.y;
  if (x + w > visible.x + visible.width) x = visible.x + visible.width - w;
  if (y + h > visible.y + visible.height) y = visible.y + visible.height - h;
  return { x, y, width: w, height: h, clamped: x !== rect.x || y !== rect.y || w !== rect.width || h !== rect.height };
}

class BrowserPaneStack {
  constructor({ screen, log }) {
    this.screen = screen;
    this.log = log || (() => {});
    this.panes = []; // [{id, view, slot}]
  }

  layout(mainBounds) {
    // Vertical tile inside the main window content area, right 62% zone.
    const zone = {
      x: mainBounds.x + Math.floor(mainBounds.width * 0.38),
      y: mainBounds.y,
      width: Math.floor(mainBounds.width * 0.62),
      height: mainBounds.height,
    };
    const n = Math.max(1, this.panes.length);
    const per = Math.floor(zone.height / n);
    this.panes.forEach((pane, i) => {
      const wanted = { x: zone.x, y: zone.y + per * i, width: zone.width, height: per };
      const visible = this.screen.getDisplayMatching(wanted).workArea;
      const rect = clampRectToVisibleFrame(wanted, visible);
      if (rect.clamped) this.log({ event: 'pane-clamped', id: pane.id, wanted, rect });
      pane.view.setBounds(rect);
      pane.slot = i;
    });
  }

  add(id, view, mainBounds) {
    if (this.panes.some((p) => p.id === id)) return this.raise(id);
    this.panes.push({ id, view, slot: this.panes.length });
    this.layout(mainBounds);
    return id;
  }

  raise(id) {
    const i = this.panes.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const [pane] = this.panes.splice(i, 1);
    this.panes.push(pane);
    return id; // Focus Rail renders stack order; top = last
  }

  remove(id, mainBounds) {
    this.panes = this.panes.filter((p) => p.id !== id);
    this.layout(mainBounds);
  }
}

// Guard for any legacy window.open / new-window path in the app layer:
// deny the free window, return the request so the caller routes it to a pane.
function denyFreeWindow(event, url) {
  event.preventDefault();
  return { denied: true, url, routeTo: 'BrowserPaneStack' };
}

module.exports = { BrowserPaneStack, clampRectToVisibleFrame, denyFreeWindow };
