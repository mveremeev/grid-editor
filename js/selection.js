// selection.js — rectangular selections and block operations.
// Selections are always rectangles (it's a grid). With a selection active,
// arrow keys nudge the whole block; cut/copy/paste move larger pieces.

import { PAGE_COLS } from './config.js';
import { insertImage } from './images.js';

/** Normalised rectangle spanning two cursor positions (inclusive). */
export function rectFrom(a, b) {
  return {
    r0: Math.min(a.row, b.row),
    r1: Math.max(a.row, b.row),
    c0: Math.min(a.col, b.col),
    c1: Math.max(a.col, b.col),
  };
}

/** All stored cells inside a rect. */
export function cellsInRect(doc, rect) {
  return doc.cellsInRect(rect.r0, rect.r1, rect.c0, rect.c1);
}

/** A cell's style flags (bold/italic/underline/strike) as booleans. */
export function styleOf(v) {
  return { b: !!v.b, i: !!v.i, u: !!v.u, s: !!v.s };
}

function cursorMeta(editor) {
  return {
    row: editor.cursor.row,
    col: editor.cursor.col,
    anchor: editor.anchorCol,
  };
}

/** "3R × 12C" — the size of a rect, the way Excel reads it out. */
function fmtSize(rect) {
  return `${rect.r1 - rect.r0 + 1}R × ${rect.c1 - rect.c0 + 1}C`;
}

/**
 * Move the selected block by (dr, dc). Non-destructive: the first nudge
 * lifts a snapshot of the block and "floats" it over the document; further
 * nudges just move the float. Nothing is written until the move is
 * confirmed (commitFloat) — content the box passes over is only occluded,
 * never erased. Escape (cancelFloat) returns the block to its origin.
 */
export function nudgeSelection(editor, dr, dc) {
  const rect = editor.selection;
  if (!rect) return;
  // Refuse moves past the origin up front, before a float exists — a
  // refused first nudge must not leave a zero-offset "move in progress".
  if (rect.r0 + dr < 0 || rect.c0 + dc < 0) {
    editor.flashStatus?.('Edge of sheet');
    return;
  }
  // In paged view, blocks stay on the page — no nudging out onto the desk.
  if (editor.viewMode === 'paged' && rect.c1 + dc > PAGE_COLS - 1) {
    editor.flashStatus?.('Edge of page');
    return;
  }

  let f = editor.float;
  if (!f) {
    f = editor.float = {
      rect0: { ...rect },                       // where the block was lifted
      items: cellsInRect(editor.doc, rect)      // snapshot of its content
        .map(v => ({ r: v.r, c: v.c, ch: v.ch, ...styleOf(v) })),
      dr: 0,
      dc: 0,
      cursor0: { ...editor.cursor },            // restored on cancel/undo
      anchor0: editor.anchorCol,
    };
  }

  const ndr = f.dr + dr;
  const ndc = f.dc + dc;
  f.dr = ndr;
  f.dc = ndc;

  editor.selection = {
    r0: f.rect0.r0 + ndr, r1: f.rect0.r1 + ndr,
    c0: f.rect0.c0 + ndc, c1: f.rect0.c1 + ndc,
  };
  if (editor.selAnchor) {
    editor.selAnchor.row += dr;
    editor.selAnchor.col += dc;
  }
  editor.cursor = {
    row: Math.max(0, editor.cursor.row + dr),
    col: Math.max(0, editor.cursor.col + dc),
  };
  editor.ensureCursorVisible();
  editor.requestRender();
}

/**
 * Lift a copy of the selection into a "ghost" float: same floating-move
 * mechanics, but the source stays put — dropping it stamps a duplicate.
 * Pasting uses the same shape (the clipboard block is the ghost).
 */
export function liftCopy(editor) {
  const rect = editor.selection;
  if (!rect || editor.float) return;
  editor.float = {
    ghost: true,
    rect0: { ...rect },
    items: cellsInRect(editor.doc, rect)
      .map(v => ({ r: v.r, c: v.c, ch: v.ch, ...styleOf(v) })),
    dr: 0,
    dc: 0,
    cursor0: { ...editor.cursor },
    anchor0: editor.anchorCol,
  };
  editor.requestRender();
}

/**
 * Confirm a floating move, as a single undoable batch: erase the block at
 * its origin (unless it's a ghost — a paste or a copy-drag, which has no
 * source to erase), clear everything under the destination rectangle (the
 * preview showed it occluded — the drop makes that real), then write the
 * block. Returns true if the document changed.
 */
export function commitFloat(editor) {
  const f = editor.float;
  if (!f) return false;
  editor.float = null;
  if (!f.ghost && !f.dr && !f.dc) {
    editor.requestRender();
    return false;
  }
  const dest = {
    r0: f.rect0.r0 + f.dr, r1: f.rect0.r1 + f.dr,
    c0: f.rect0.c0 + f.dc, c1: f.rect0.c1 + f.dc,
  };
  const before = { row: f.cursor0.row, col: f.cursor0.col, anchor: f.anchor0 };
  editor.doc.begin();
  if (!f.ghost) {
    for (const it of f.items) editor.doc.write(it.r, it.c, null);
  }
  for (const v of cellsInRect(editor.doc, dest)) {
    editor.doc.write(v.r, v.c, null);
  }
  for (const it of f.items) {
    editor.doc.write(it.r + f.dr, it.c + f.dc,
      { ch: it.ch, ...styleOf(it) });
  }
  const changed = editor.doc.commit({ before, after: cursorMeta(editor) });
  if (changed) {
    editor.setFlash?.(dest);
    editor.markChanged();
  } else {
    editor.requestRender();
  }
  return changed;
}

/**
 * Cancel a floating move: the block stays at its origin (the document was
 * never touched), the selection is dismissed, and the cursor returns to
 * where the move began. Returns true if there was a float to cancel.
 */
export function cancelFloat(editor) {
  const f = editor.float;
  if (!f) return false;
  editor.float = null;
  editor.selection = null;
  editor.selAnchor = null;
  editor.cursor = { ...f.cursor0 };
  editor.anchorCol = f.anchor0;
  editor.ensureCursorVisible();
  editor.requestRender();
  return true;
}

/** The active selection, or the cursor cell as a 1×1 rect. */
function effectiveRect(editor) {
  return editor.selection ||
    rectFrom(editor.cursor, editor.cursor);
}

/**
 * Reconstruct plain text from a rect. Even rows always produce a line;
 * empty midline rows are skipped (lossy by design).
 */
export function rectToText(doc, rect) {
  const byRow = new Map();
  for (const v of cellsInRect(doc, rect)) {
    let row = byRow.get(v.r);
    if (!row) byRow.set(v.r, (row = new Map()));
    row.set(v.c, v.ch);
  }
  const lines = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const row = byRow.get(r);
    if (r % 2 !== 0 && !row) continue; // skip empty midlines
    let line = '';
    if (row) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        line += row.get(c) || ' ';
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

/** Copy the selection (or cursor cell) to the internal block clipboard. */
export function copySelection(editor) {
  commitFloat(editor); // a mid-move copy reads the block where it landed
  const rect = effectiveRect(editor);
  editor.clipboard = {
    rows: rect.r1 - rect.r0 + 1,
    cols: rect.c1 - rect.c0 + 1,
    items: cellsInRect(editor.doc, rect).map(v => ({
      dr: v.r - rect.r0,
      dc: v.c - rect.c0,
      ch: v.ch,
      ...styleOf(v),
    })),
  };
  // Best-effort mirror to the system clipboard as plain text.
  const text = rectToText(editor.doc, rect);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  // Marching ants around the source, like Excel; Esc or any edit clears.
  editor.ants = { ...rect };
  editor.flashStatus?.(`Copied ${fmtSize(rect)}`);
  editor.requestRender();
}

/**
 * Clear every cell in the selection (or the cursor cell). Returns true if
 * anything was actually erased — callers use this to decide where the
 * cursor should land (an empty selection shouldn't move it).
 */
export function clearSelection(editor) {
  commitFloat(editor);
  const rect = effectiveRect(editor);
  const before = cursorMeta(editor);
  editor.doc.begin();
  for (const v of cellsInRect(editor.doc, rect)) {
    editor.doc.write(v.r, v.c, null);
  }
  const changed = editor.doc.commit({ before, after: before });
  if (changed) editor.markChanged();
  return changed;
}

export function cutSelection(editor) {
  const rect = effectiveRect(editor);
  copySelection(editor);
  clearSelection(editor);
  editor.ants = null; // nothing left at the source to march around
  editor.flashStatus?.(`Cut ${fmtSize(rect)}`);
}

/**
 * Paste at the cursor — as a preview. The block arrives as a translucent
 * ghost float over the sheet: nothing is written until it's confirmed
 * (Enter, clicking, typing), and Esc or right-click throws it away.
 * Prefers the internal block clipboard; falls back to plain text from the
 * system clipboard (each line lands on successive character rows).
 */
export async function paste(editor) {
  commitFloat(editor);
  // A picture on the system clipboard wins: copying cells here always
  // mirrors text out, so a stale image can never shadow a cell copy.
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const t = item.types.find((x) => x.startsWith('image/'));
        if (t) {
          await insertImage(editor, await item.getType(t),
            { ...editor.cursor });
          return;
        }
      }
    } catch { /* no permission or unsupported — cells still paste */ }
  }
  let block = editor.clipboard;
  if (!block && navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) block = textToBlock(text);
    } catch {
      /* permission denied — nothing to paste */
    }
  }
  if (!block || !block.items.length) {
    editor.flashStatus?.('Nothing to paste');
    return;
  }

  const { row, col } = editor.cursor;
  let items;
  let rect;
  if (editor.viewMode === 'paged') {
    // Paged view: the paste wraps at the page margin, exactly as if it
    // had been typed from the cursor — overflow carries onto rows below.
    items = wrapBlockItems(block.items, row, col, PAGE_COLS);
    rect = itemBounds(items, row, col);
    if (rect.r1 > row + block.rows - 1) {
      editor.flashStatus?.('Wrapped at the page margin');
    }
  } else {
    items = block.items.map(it => ({
      r: row + it.dr, c: col + it.dc, ch: it.ch, ...styleOf(it),
    }));
    rect = {
      r0: row, r1: row + block.rows - 1,
      c0: col, c1: col + block.cols - 1,
    };
  }
  editor.float = {
    ghost: true,
    rect0: rect,
    items,
    dr: 0,
    dc: 0,
    cursor0: { ...editor.cursor },
    anchor0: editor.anchorCol,
  };
  editor.selection = { ...rect };
  editor.selAnchor = { row: rect.r0, col: rect.c0 };
  editor.ensureCursorVisible();
  editor.requestRender();
}

/**
 * Lay a clipboard block down at (row, col), wrapping at `width` columns
 * the way the rewrap-to-page does: overflow is cut at the margin and
 * carried onto continuation rows of the same parity, and later block
 * rows shift down to make room.
 */
function wrapBlockItems(items, row, col, width) {
  const byRow = new Map();
  for (const it of items) {
    let a = byRow.get(it.dr);
    if (!a) byRow.set(it.dr, (a = []));
    a.push(it);
  }
  const out = [];
  let shift = 0;
  for (const dr of [...byRow.keys()].sort((a, b) => a - b)) {
    let maxChunk = 0;
    for (const it of byRow.get(dr)) {
      const abs = col + it.dc;
      const chunk = Math.floor(abs / width);
      if (chunk > maxChunk) maxChunk = chunk;
      out.push({
        r: row + dr + shift + 2 * chunk,
        c: abs % width,
        ch: it.ch,
        ...styleOf(it),
      });
    }
    shift += 2 * maxChunk;
  }
  return out;
}

/** Bounding rect of laid-out items, anchored at the paste position. */
function itemBounds(items, row, col) {
  let r1 = row, c0 = col, c1 = col;
  for (const it of items) {
    if (it.r > r1) r1 = it.r;
    if (it.c < c0) c0 = it.c;
    if (it.c > c1) c1 = it.c;
  }
  return { r0: row, r1, c0, c1 };
}

/** Parse plain text into a pasteable block: line i → row offset 2i. */
export function textToBlock(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const items = [];
  let cols = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, '    ');
    if (line.length > cols) cols = line.length;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch !== ' ') items.push({ dr: 2 * i, dc: j, ch, b: false });
    }
  }
  return { rows: Math.max(1, 2 * lines.length - 1), cols, items };
}

/**
 * Toggle one style flag ('b' | 'i' | 'u' | 's') on the selection (or
 * cursor cell): if every character already has it, remove it; otherwise
 * apply it to everything. Other styles are left alone.
 */
export function toggleStyleSelection(editor, key = 'b') {
  commitFloat(editor);
  const rect = effectiveRect(editor);
  const items = cellsInRect(editor.doc, rect);
  if (!items.length) return;
  const all = items.every(v => v[key]);
  const before = cursorMeta(editor);
  editor.doc.begin();
  for (const v of items) {
    editor.doc.write(v.r, v.c,
      { ch: v.ch, ...styleOf(v), [key]: !all });
  }
  if (editor.doc.commit({ before, after: before })) editor.markChanged();
}
