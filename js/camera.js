// camera.js — grid geometry (parity-aware row math) and the camera
// (scroll offset + zoom) that converts between screen and grid space.

import {
  CELL_W, CELL_H, MID_H, PAIR_H, PAGE_GAP, PAGE_COLS, EDGE_PAD,
  ZOOM_MIN, ZOOM_MAX, ZOOM_SNAP,
} from './config.js';

// ---- Row parity geometry -------------------------------------------------
// Even rows are character rows (CELL_H tall); odd rows are midlines
// (MID_H tall). Rows stack 0,1,2,3,... from the hard top-left origin.
// In paged view, a gap opens between every PAGE_ROW_SPAN rows — the row
// math here is the single source of truth for that offset, so everything
// that uses rowTop/rowAtY (renderer, cursor, clicks) follows along.

let pageSpan = 0; // rows per page when paged view is on; 0 = infinite

export function setPagedRows(span) {
  pageSpan = span;
}

/** World-space Y of the top edge of row r. */
export function rowTop(r) {
  const base = r % 2 === 0
    ? (r / 2) * PAIR_H
    : ((r - 1) / 2) * PAIR_H + CELL_H;
  return pageSpan
    ? base + Math.floor(r / pageSpan) * PAGE_GAP
    : base;
}

/** World-space height of row r. */
export function rowHeight(r) {
  return r % 2 === 0 ? CELL_H : MID_H;
}

/** Row index containing world-space Y (clamped to the origin). */
export function rowAtY(y) {
  if (y < 0) return 0;
  let offset = 0;
  if (pageSpan) {
    const pageH = (pageSpan / 2) * PAIR_H;
    const stride = pageH + PAGE_GAP;
    const p = Math.floor(y / stride);
    y -= p * stride;
    if (y >= pageH) return (p + 1) * pageSpan; // the gap → next page's top
    offset = p * pageSpan;
  }
  const k = Math.floor(y / PAIR_H);
  const rem = y - k * PAIR_H;
  return offset + (rem < CELL_H ? 2 * k : 2 * k + 1);
}

/** World-space X of the left edge of column c. */
export function colLeft(c) {
  return c * CELL_W;
}

/** Column index containing world-space X (clamped to the origin). */
export function colAtX(x) {
  return Math.max(0, Math.floor(x / CELL_W));
}

// ---- Camera ----------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The camera holds a world-space scroll offset (x, y) and a zoom level.
 * screen = (world - offset) * zoom. Panning is clamped just past the
 * top-left origin (-EDGE_PAD), so the sheet's corner sits a little in
 * from the window edge instead of pressed against the chrome.
 */
export class Camera {
  constructor() {
    this.x = -EDGE_PAD;
    this.y = -EDGE_PAD;
    this.zoom = 1;
    this.viewW = 0; // CSS-pixel viewport size, kept fresh by the renderer
    this.viewH = 0;
  }

  toScreenX(wx) { return (wx - this.x) * this.zoom; }
  toScreenY(wy) { return (wy - this.y) * this.zoom; }
  toWorldX(sx) { return this.x + sx / this.zoom; }
  toWorldY(sy) { return this.y + sy / this.zoom; }

  /** Clamp an x offset: past the origin pad, and — in paged view —
   *  never scrolled beyond the page's right edge. */
  _clampX(x) {
    if (pageSpan && this.viewW) {
      const limit = PAGE_COLS * CELL_W + EDGE_PAD - this.viewW / this.zoom;
      x = Math.min(x, Math.max(-EDGE_PAD, limit));
    }
    return Math.max(-EDGE_PAD, x);
  }

  /** Pan by a screen-space delta, clamped just past the origin. */
  panBy(dxScreen, dyScreen) {
    this.x = this._clampX(this.x + dxScreen / this.zoom);
    this.y = Math.max(-EDGE_PAD, this.y + dyScreen / this.zoom);
  }

  /**
   * Set zoom, keeping the world point under screen point (sx, sy) fixed —
   * i.e. zoom toward the pointer (mouse) or the cursor (keyboard).
   */
  setZoom(z, sx, sy) {
    z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    // 100% has a small capture zone, so wheel-zooming never strands the
    // view at 99% with no way to land exactly back home.
    if (Math.abs(z - 1) <= ZOOM_SNAP) z = 1;
    const wx = this.toWorldX(sx);
    const wy = this.toWorldY(sy);
    this.zoom = z;
    this.x = this._clampX(wx - sx / z);
    this.y = Math.max(-EDGE_PAD, wy - sy / z);
  }

  zoomBy(factor, sx, sy) {
    this.setZoom(this.zoom * factor, sx, sy);
  }
}
