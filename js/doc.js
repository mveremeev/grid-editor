// doc.js — the document. A sparse map of cells (coordinate → character)
// is the whole data model: empty cells simply aren't in the map, which is
// what makes the infinite canvas cheap. Undo/redo is a stack of cell-map
// diffs grouped into batches.

const K = (r, c) => r + ',' + c;

const UNDO_LIMIT = 500;

export class GridDoc {
  constructor() {
    /** @type {Map<string, {r:number, c:number, ch:string, b:boolean}>} */
    this.cells = new Map();
    /** @type {Map<number, Map<number, {r:number, c:number, ch:string, b:boolean}>>} */
    this.rows = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this._pending = null; // changes being collected for the current batch
    this._pendingImg = null; // image ops riding in the same batch
  }

  /** Cell at (r, c), or null if empty. */
  get(r, c) {
    const row = this.rows.get(r);
    return row ? row.get(c) || null : null;
  }

  /** Apply a value directly to the map (no undo recording). */
  _apply(r, c, cell) {
    const k = K(r, c);
    if (cell) {
      const value = {
        r, c, ch: cell.ch,
        b: !!cell.b, i: !!cell.i, u: !!cell.u, s: !!cell.s,
      };
      let row = this.rows.get(r);
      if (!row) this.rows.set(r, (row = new Map()));
      this.cells.set(k, value);
      row.set(c, value);
    } else {
      this.cells.delete(k);
      const row = this.rows.get(r);
      if (row) {
        row.delete(c);
        if (!row.size) this.rows.delete(r);
      }
    }
  }

  /**
   * Begin collecting an undoable batch of writes. If a batch is somehow
   * already open, keep collecting into it — merging beats silently
   * dropping recorded changes.
   */
  begin() {
    if (!this._pending) {
      this._pending = [];
      this._pendingImg = [];
    }
  }

  /**
   * Record an image-frame operation in the current batch. The op carries
   * direct references ({arr, img}) plus before/after rects (null before
   * = an add, null after = a delete), so undo/redo can replay it without
   * the document knowing what an image is.
   */
  imageOp(op) {
    if (this._pendingImg) this._pendingImg.push(op);
  }

  /**
   * Write a cell ({ch, b} or null to clear) inside the current batch.
   * Writes past the origin are ignored — no negative rows or columns.
   */
  write(r, c, cell) {
    if (r < 0 || c < 0) return;
    const before = this.get(r, c);
    const sameStyle = (a, x) =>
      !!a.b === !!x.b && !!a.i === !!x.i &&
      !!a.u === !!x.u && !!a.s === !!x.s;
    const same =
      (!before && !cell) ||
      (before && cell && before.ch === cell.ch && sameStyle(before, cell));
    if (same) return;
    const snap = (v) => v
      ? { ch: v.ch, b: !!v.b, i: !!v.i, u: !!v.u, s: !!v.s }
      : null;
    if (this._pending) {
      this._pending.push({ r, c, before: snap(before), after: snap(cell) });
    }
    this._apply(r, c, cell);
  }

  /**
   * Close the batch. `meta` (e.g. cursor before/after) is stored with it
   * and handed back on undo/redo. Returns true if anything changed.
   */
  commit(meta) {
    const p = this._pending;
    const pi = this._pendingImg;
    this._pending = null;
    this._pendingImg = null;
    if ((p && p.length) || (pi && pi.length)) {
      this.undoStack.push({
        changes: p || [],
        images: pi || [],
        meta: meta || null,
      });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      return true;
    }
    return false;
  }

  /** Revert one image op: un-add, un-delete, or restore the old frame. */
  static _revertImageOp(op) {
    if (!op.before) {
      const i = op.arr.indexOf(op.img);
      if (i >= 0) op.arr.splice(i, 1);
    } else if (!op.after) {
      Object.assign(op.img, op.before);
      op.arr.push(op.img);
    } else {
      Object.assign(op.img, op.before);
    }
  }

  /** Re-apply one image op. */
  static _applyImageOp(op) {
    if (!op.before) {
      Object.assign(op.img, op.after);
      op.arr.push(op.img);
    } else if (!op.after) {
      const i = op.arr.indexOf(op.img);
      if (i >= 0) op.arr.splice(i, 1);
    } else {
      Object.assign(op.img, op.after);
    }
  }

  /** Revert the last batch. Returns its meta, or null if nothing to undo. */
  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    for (let i = e.changes.length - 1; i >= 0; i--) {
      const ch = e.changes[i];
      this._apply(ch.r, ch.c, ch.before);
    }
    const imgs = e.images || [];
    for (let i = imgs.length - 1; i >= 0; i--) {
      GridDoc._revertImageOp(imgs[i]);
    }
    this.redoStack.push(e);
    return e.meta || { };
  }

  /** Re-apply the last undone batch. Returns its meta, or null. */
  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    for (const ch of e.changes) this._apply(ch.r, ch.c, ch.after);
    for (const op of e.images || []) GridDoc._applyImageOp(op);
    this.undoStack.push(e);
    return e.meta || { };
  }

  /** Bounding extent of all content, or null when the document is empty. */
  bounds() {
    if (!this.cells.size) return null;
    let maxRow = 0, maxCol = 0;
    for (const v of this.cells.values()) {
      if (v.r > maxRow) maxRow = v.r;
      if (v.c > maxCol) maxCol = v.c;
    }
    return { maxRow, maxCol };
  }

  /** Stored cells inside the given inclusive visible/selection rectangle. */
  cellsInRect(r0, r1, c0, c1) {
    const out = [];
    const rowSpan = r1 - r0 + 1;
    if (rowSpan <= this.rows.size) {
      for (let r = r0; r <= r1; r++) {
        const row = this.rows.get(r);
        if (!row) continue;
        for (const v of row.values()) {
          if (v.c >= c0 && v.c <= c1) out.push(v);
        }
      }
    } else {
      for (const [r, row] of this.rows) {
        if (r < r0 || r > r1) continue;
        for (const v of row.values()) {
          if (v.c >= c0 && v.c <= c1) out.push(v);
        }
      }
    }
    return out;
  }

  /** Stored cells in one row, sorted left to right. */
  rowCells(r) {
    const row = this.rows.get(r);
    return row ? Array.from(row.values()).sort((a, b) => a.c - b.c) : [];
  }

  /** Contiguous filled run containing (r, c), or null if the cell is empty. */
  runAt(r, c) {
    const row = this.rows.get(r);
    if (!row || !row.has(c)) return null;
    let c0 = c, c1 = c;
    while (row.has(c0 - 1)) c0--;
    while (row.has(c1 + 1)) c1++;
    return { c0, c1 };
  }

  /** Extent of stored content in one row, or null if the row is empty. */
  rowExtent(r) {
    const row = this.rows.get(r);
    if (!row || !row.size) return null;
    let c0 = Infinity, c1 = -Infinity;
    for (const c of row.keys()) {
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
    }
    return { c0, c1 };
  }

  /**
   * Excel-style data-edge jump along a row: from inside a run, go to the
   * run's far end; from a gap, go to the next filled cell; with nothing
   * ahead, go to the sheet edge (leftward) or stay put (rightward).
   */
  nextEdgeCol(r, c, dir) {
    const row = this.rows.get(r);
    const has = (x) => !!(row && row.has(x));
    let p = c + dir;
    if (p < 0) return 0;
    if (has(c) && has(p)) {
      while (p + dir >= 0 && has(p + dir)) p += dir;
      return Math.max(0, p);
    }
    const ext = this.rowExtent(r);
    if (ext) {
      while (dir > 0 ? p <= ext.c1 : p >= 0) {
        if (has(p)) return p;
        p += dir;
      }
    }
    return dir < 0 ? 0 : c;
  }

  /**
   * The same jump down a column. Steps keep the cursor's row parity, so a
   * character-row jump never lands on a midline (and vice versa).
   */
  nextEdgeRow(r, c, dir) {
    const step = 2 * dir;
    const top = r % 2; // topmost row of this parity
    const has = (y) => {
      const m = this.rows.get(y);
      return !!(m && m.has(c));
    };
    let max = -Infinity;
    for (const [y, m] of this.rows) {
      if (y % 2 === top && y > max && m.has(c)) max = y;
    }
    let p = r + step;
    if (p < top) return top;
    if (has(r) && has(p)) {
      while (p + step >= top && has(p + step)) p += step;
      return Math.max(top, p);
    }
    if (max >= 0) {
      while (dir > 0 ? p <= max : p >= top) {
        if (has(p)) return p;
        p += step;
      }
    }
    return dir < 0 ? top : r;
  }

  /** Replace all content (used by load/open); resets history. */
  load(items) {
    this.cells.clear();
    this.rows.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    for (const it of items) {
      if (it.r >= 0 && it.c >= 0 && it.ch) this._apply(it.r, it.c, it);
    }
  }

  clear() {
    this.load([]);
  }
}
