// keyboard.js — every action is reachable from the keyboard.
// Typing overwrites the cell under the cursor and advances right; nothing
// ever shifts. Vertical arrows step by 2 (cell to cell); Alt steps by 1
// (onto/off the midline).

import {
  TAB_W, PAIR_H, CELL_W, ZOOM_KEY_STEP, PAGE_COLS,
} from './config.js';
import { rowTop, rowHeight, colLeft } from './camera.js';
import {
  rectFrom, nudgeSelection, copySelection, cutSelection, paste,
  clearSelection, toggleStyleSelection, commitFloat, cancelFloat,
} from './selection.js';
import { deleteImage, moveImage } from './images.js';
import {
  saveToFile, openFilePicker, scheduleAutosave,
} from './persistence.js';

export function installKeyboard(editor) {
  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // let the IME finish its composition
    const t = e.target;
    if (t instanceof HTMLElement &&
        t.closest('input, textarea, select, button, a, [contenteditable]')) {
      // Let the toolbar behave like a normal toolbar — but app-level
      // chords still work there: F1, and save/open (which would otherwise
      // hit the browser's own dialogs). Escape returns focus to the grid.
      if (e.key === 'Escape') {
        t.blur();
        editor.ui.hideContextMenu?.();
        editor.canvas.focus();
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        editor.ui.toggleHelp();
        return;
      }
      if (isPrimaryMod(e)) {
        const k = shortcutKey(e);
        if (k === 's') {
          e.preventDefault();
          commitFloat(editor);
          saveToFile(editor);
        } else if (k === 'o') {
          e.preventDefault();
          commitFloat(editor);
          openFilePicker();
        } else if (k === 'f') {
          e.preventDefault(); // ours, not the browser's page-find
          editor.ui.openFind?.();
        } else if (k === 'p') {
          e.preventDefault();
          editor.ui.requestPrint?.();
        }
      }
      return;
    }
    handleKey(editor, e);
  });
}

const isPrimaryMod = (e) => e.ctrlKey || e.metaKey;
const isWordDeleteMod = (e) => e.ctrlKey || e.altKey;
const isRowDeleteMod = (e) => e.metaKey || (e.ctrlKey && e.shiftKey);

/**
 * The key for a Ctrl/Cmd chord, independent of keyboard layout. `e.key`
 * follows the active layout (Cyrillic Cmd+Z reports 'я'), so when it isn't
 * a plain Latin character we fall back to the physical `e.code`
 * (KeyZ/Digit0), which is layout-stable. Latin layouts keep their own
 * mapping (e.g. AZERTY Ctrl+A is the A key, wherever it sits).
 */
function shortcutKey(e) {
  const k = e.key.toLowerCase();
  if (/^[a-z0-9=+\-]$/.test(k)) return k;
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code);
  return m ? (m[1] || m[2]).toLowerCase() : k;
}

function cursorMeta(editor) {
  return {
    row: editor.cursor.row,
    col: editor.cursor.col,
    anchor: editor.anchorCol,
  };
}

function restoreMeta(editor, m) {
  if (!m) return;
  editor.selection = null;
  editor.selAnchor = null;
  editor.cursor = { row: m.row, col: m.col };
  editor.anchorCol = m.anchor;
  editor.ensureCursorVisible();
}

/** Brief pulse on the cursor cell so the eye finds where undo/redo went. */
function pulseCursor(editor, m) {
  if (!m || m.row == null) return;
  editor.setFlash?.({ r0: m.row, r1: m.row, c0: m.col, c1: m.col });
}

/** The selected image, if it still exists on this sheet. */
function selectedImage(editor) {
  const im = editor.imageSel;
  return im && editor.images.includes(im) ? im : null;
}

function handleKey(editor, e) {
  const mod = isPrimaryMod(e);

  // A selected picture takes Delete/Backspace before the cells do.
  if (selectedImage(editor) &&
      (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    deleteImage(editor, editor.imageSel);
    return;
  }

  if (e.key === 'Backspace') {
    backspace(editor, e);
    return;
  }

  // Navigation keys go first: they carry their own modifier handling
  // (Ctrl/Cmd+arrows jump to content edges, mod+Home/End to the extents)
  // and must not be swallowed by the chord switch below.
  switch (e.key) {
    case 'ArrowLeft': arrow(editor, e, 0, -1); return;
    case 'ArrowRight': arrow(editor, e, 0, 1); return;
    case 'ArrowUp': arrow(editor, e, -1, 0); return;
    case 'ArrowDown': arrow(editor, e, 1, 0); return;
    case 'Home':
      e.preventDefault();
      if (mod) editor.setCursor(0, 0);
      else editor.setCursor(editor.cursor.row, 0);
      return;
    case 'End': {
      e.preventDefault();
      if (mod) {
        const b = editor.doc.bounds();
        editor.setCursor(b ? b.maxRow : 0, b ? b.maxCol : 0);
        return;
      }
      const { row } = editor.cursor;
      const cells = editor.doc.rowCells(row);
      const last = cells.length ? cells[cells.length - 1].c : -1;
      editor.setCursor(row, last + 1);
      return;
    }
    default:
      break;
  }

  if (mod) {
    switch (shortcutKey(e)) {
      case 's':
        e.preventDefault();
        commitFloat(editor);
        saveToFile(editor);
        return;
      case 'o':
        e.preventDefault();
        commitFloat(editor);
        openFilePicker();
        return;
      case 'z': {
        e.preventDefault();
        // Mid-move, undo cancels the float (the doc was never touched).
        if (cancelFloat(editor)) return;
        const meta = e.shiftKey ? editor.doc.redo() : editor.doc.undo();
        if (meta) {
          const m = e.shiftKey ? meta.after : meta.before;
          restoreMeta(editor, m);
          if (!selectedImage(editor)) editor.imageSel = null;
          editor.markChanged();
          pulseCursor(editor, m);
        }
        return;
      }
      case 'y': {
        e.preventDefault();
        if (cancelFloat(editor)) return;
        const meta = editor.doc.redo();
        if (meta) {
          restoreMeta(editor, meta.after);
          if (!selectedImage(editor)) editor.imageSel = null;
          editor.markChanged();
          pulseCursor(editor, meta.after);
        }
        return;
      }
      case 'c':
        e.preventDefault();
        copySelection(editor);
        return;
      case 'x':
        e.preventDefault();
        cutSelection(editor);
        return;
      case 'v':
        e.preventDefault();
        paste(editor);
        return;
      // Styles, Excel's bindings: B / I / U, and Ctrl+5 for strikethrough.
      // With a selection they style the block; without, they toggle the
      // pen for new typing.
      case 'b': styleKey(editor, e, 'b'); return;
      case 'i': styleKey(editor, e, 'i'); return;
      case 'u': styleKey(editor, e, 'u'); return;
      case '5': styleKey(editor, e, 's'); return;
      case 'f':
        e.preventDefault();
        editor.ui.openFind?.();
        return;
      case 'p':
        e.preventDefault(); // print pages, not the app chrome
        editor.ui.requestPrint?.();
        return;
      case 'a': {
        e.preventDefault();
        commitFloat(editor);
        const b = editor.doc.bounds();
        if (b) {
          editor.selAnchor = { row: 0, col: 0 };
          editor.selection = { r0: 0, c0: 0, r1: b.maxRow, c1: b.maxCol };
          editor.cursor = { row: b.maxRow, col: b.maxCol };
          editor.requestRender();
        }
        return;
      }
      case '=': case '+':
        e.preventDefault();
        zoomAtCursor(editor, ZOOM_KEY_STEP);
        return;
      case '-':
        e.preventDefault();
        zoomAtCursor(editor, -ZOOM_KEY_STEP);
        return;
      case '0':
        e.preventDefault();
        zoomAtCursor(editor, 1 - editor.camera.zoom);
        return;
      default:
        return; // leave other browser shortcuts alone
    }
  }

  switch (e.key) {
    case 'Enter': enter(editor, e); return;
    case 'Tab': tab(editor, e); return;
    case 'Delete': del(editor, e); return;
    case 'PageUp': page(editor, e, -1); return;
    case 'PageDown': page(editor, e, 1); return;
    case 'Escape':
      if (editor.ui.isHelpOpen()) editor.ui.closeHelp();
      // Mid-move: send the block home and dismiss the selection.
      else if (cancelFloat(editor)) break;
      else if (selectedImage(editor)) {
        editor.imageSel = null;
        editor.requestRender();
      } else if (editor.ants) {
        editor.ants = null; // dismiss the marching ants
        editor.requestRender();
      } else if (editor.ui.closeFind && editor.ui.closeFind()) {
        // find bar dismissed
      } else {
        editor.setCursor(editor.cursor.row, editor.cursor.col); // deselect
      }
      return;
    case 'F1':
      e.preventDefault();
      editor.ui.toggleHelp();
      return;
    default:
      break;
  }

  // Printable character → overwrite the cell and advance right.
  // (Alt is allowed through so macOS Option-characters and AltGr work;
  // Alt alone never produces a printable key for the bindings above.)
  if (e.key.length === 1 && !e.metaKey && (!e.ctrlKey || e.altKey)) {
    e.preventDefault();
    typeChar(editor, e.key);
  }
}

function styleKey(editor, e, key) {
  e.preventDefault();
  if (editor.selection) toggleStyleSelection(editor, key);
  else editor.setPen(key, !editor.pen[key]);
}

function typeChar(editor, ch) {
  commitFloat(editor); // typing confirms a move in progress
  const paged = editor.viewMode === 'paged';
  let { row, col } = editor.cursor;
  // Paged view wraps at the right margin, like any writer: a cursor at
  // (or past) the margin types onto the next character row instead.
  if (paged && col >= PAGE_COLS) {
    row = row % 2 === 0 ? row + 2 : row + 1;
    col = 0;
  }
  const before = cursorMeta(editor);
  editor.doc.begin();
  // Space is an eraser, not a character: storing invisible ' ' cells
  // would pollute End, export, and the content-edge jumps.
  editor.doc.write(row, col, ch === ' ' ? null : { ch, ...editor.pen });
  editor.selection = null;
  editor.selAnchor = null;
  if (paged && col + 1 >= PAGE_COLS) {
    // Filled the last column — carriage-return to the next row.
    editor.cursor = { row: row % 2 === 0 ? row + 2 : row + 1, col: 0 };
    editor.anchorCol = 0;
  } else {
    editor.cursor = { row, col: col + 1 }; // advance; anchor stays put
  }
  editor.doc.commit({ before, after: cursorMeta(editor) });
  editor.ensureCursorVisible();
  editor.markChanged();
}

/** Where a Ctrl/Cmd+arrow lands: the edge of the content region. */
function edgeTarget(editor, dr, dc) {
  const { row, col } = editor.cursor;
  return dc !== 0
    ? { row, col: editor.doc.nextEdgeCol(row, col, dc) }
    : { row: editor.doc.nextEdgeRow(row, col, dr), col };
}

function arrow(editor, e, dr, dc) {
  e.preventDefault();
  const mod = isPrimaryMod(e);
  const stepR = dr === 0 ? 0 : (e.altKey ? dr : dr * 2);

  // Arrows nudge a selected picture by whole cells (Alt: single rows).
  const img = selectedImage(editor);
  if (img && !mod && !e.shiftKey) {
    moveImage(editor, img, stepR, dc);
    return;
  }

  // Ctrl/Cmd+arrows jump to the edge of the content region (Excel's
  // data-edge jump); Option+left/right does the same horizontally on
  // macOS. Shift extends the selection out to the target.
  if (mod || (e.altKey && dr === 0 && !editor.selection)) {
    commitFloat(editor);
    const t = edgeTarget(editor, dr, dc);
    if (editor.viewMode === 'paged') t.col = Math.min(t.col, PAGE_COLS - 1);
    if (e.shiftKey) {
      if (!editor.selAnchor) editor.selAnchor = { ...editor.cursor };
      editor.cursor = { row: t.row, col: t.col };
      editor.selection = rectFrom(editor.selAnchor, t);
      editor.anchorCol = t.col;
      editor.ensureCursorVisible();
      editor.requestRender();
    } else {
      editor.setCursor(t.row, t.col);
    }
    return;
  }

  // With a selection active (and no Shift), arrows nudge the whole block.
  if (editor.selection && !e.shiftKey) {
    nudgeSelection(editor, stepR, dc);
    return;
  }

  const nr = Math.max(0, editor.cursor.row + stepR);
  let nc = Math.max(0, editor.cursor.col + dc);
  // In paged view the cursor stays on the page — no walking (or
  // shift-selecting) out onto the desk.
  if (editor.viewMode === 'paged') nc = Math.min(nc, PAGE_COLS - 1);

  if (e.shiftKey) {
    // Extend (or start) a rectangular selection from the keyboard.
    commitFloat(editor); // resizing confirms any move in progress
    if (!editor.selAnchor) editor.selAnchor = { ...editor.cursor };
    editor.cursor = { row: nr, col: nc };
    editor.selection = rectFrom(
      { row: editor.selAnchor.row, col: editor.selAnchor.col },
      { row: nr, col: nc },
    );
    editor.anchorCol = nc;
    editor.ensureCursorVisible();
    editor.requestRender();
  } else {
    editor.setCursor(nr, nc);
  }
}

function enter(editor, e) {
  e.preventDefault();
  // With a selection, Enter confirms: drop any floating block where it is
  // and deselect — the cursor stays exactly where it is.
  if (editor.selection) {
    commitFloat(editor);
    editor.setCursor(editor.cursor.row, editor.cursor.col);
    return;
  }
  const { row } = editor.cursor;
  let nr;
  if (e.shiftKey) {
    nr = Math.max(0, row % 2 === 0 ? row - 2 : row - 1);
  } else {
    nr = row % 2 === 0 ? row + 2 : row + 1;
  }
  // Return to the anchor column so successive rows stack aligned.
  editor.setCursor(nr, editor.anchorCol, { updateAnchor: false });
}

function tab(editor, e) {
  e.preventDefault();
  const c = editor.cursor.col;
  const nc = e.shiftKey
    ? Math.max(0, Math.ceil(c / TAB_W) * TAB_W - TAB_W)
    : Math.floor(c / TAB_W) * TAB_W + TAB_W;
  editor.setCursor(editor.cursor.row, nc);
}

function backspace(editor, e) {
  e.preventDefault();
  if (editor.selection) {
    // Erasing a populated selection lands the cursor at its top-left;
    // erasing an empty one is a no-op, so the cursor stays put.
    const { r0, c0 } = editor.selection;
    const changed = clearSelection(editor);
    if (changed) editor.setCursor(r0, c0);
    else editor.setCursor(editor.cursor.row, editor.cursor.col);
    return;
  }
  if (isRowDeleteMod(e)) {
    backspaceToRowStart(editor);
    return;
  }
  if (isWordDeleteMod(e)) {
    backspaceWord(editor);
    return;
  }
  const { row, col } = editor.cursor;
  if (col === 0) {
    // Paged view: backspace at the margin hops to the end of the row
    // above and erases there — the inverse of the typing wrap.
    if (editor.viewMode === 'paged' && row > 0) {
      const pr = row % 2 === 0 ? row - 2 : row - 1;
      const before = cursorMeta(editor);
      editor.doc.begin();
      editor.doc.write(pr, PAGE_COLS - 1, null);
      editor.cursor = { row: pr, col: PAGE_COLS - 1 };
      const changed =
        editor.doc.commit({ before, after: cursorMeta(editor) });
      editor.ensureCursorVisible();
      if (changed) editor.markChanged();
      else editor.requestRender();
    }
    return;
  }
  const before = cursorMeta(editor);
  editor.doc.begin();
  editor.doc.write(row, col - 1, null);
  editor.cursor = { row, col: col - 1 };
  const changed = editor.doc.commit({ before, after: cursorMeta(editor) });
  editor.ensureCursorVisible();
  if (changed) editor.markChanged();
  else editor.requestRender();
}

function backspaceWord(editor) {
  const { row, col } = editor.cursor;
  if (col === 0) return;

  const cells = editor.doc.rowCells(row).filter(v => v.c < col);
  let i = cells.length - 1;
  while (i >= 0 && cells[i].ch === ' ') i--;

  let targetCol = 0;
  if (i >= 0) {
    targetCol = cells[i].c;
    while (i > 0 &&
        cells[i - 1].ch !== ' ' &&
        cells[i - 1].c === targetCol - 1) {
      i--;
      targetCol = cells[i].c;
    }
  }

  const before = cursorMeta(editor);
  editor.doc.begin();
  for (const v of editor.doc.cellsInRect(row, row, targetCol, col - 1)) {
    editor.doc.write(v.r, v.c, null);
  }
  editor.cursor = { row, col: targetCol };
  const changed = editor.doc.commit({ before, after: cursorMeta(editor) });
  editor.ensureCursorVisible();
  if (changed) editor.markChanged();
  else editor.requestRender();
}

function backspaceToRowStart(editor) {
  const { row, col } = editor.cursor;
  if (col === 0) return;

  const before = cursorMeta(editor);
  editor.doc.begin();
  for (const v of editor.doc.cellsInRect(row, row, 0, col - 1)) {
    editor.doc.write(v.r, v.c, null);
  }
  editor.cursor = { row, col: 0 };
  const changed = editor.doc.commit({ before, after: cursorMeta(editor) });
  editor.ensureCursorVisible();
  if (changed) editor.markChanged();
  else editor.requestRender();
}

function del(editor, e) {
  e.preventDefault();
  if (editor.selection) {
    clearSelection(editor);
    editor.setCursor(editor.cursor.row, editor.cursor.col);
    return;
  }
  const { row, col } = editor.cursor;
  const before = cursorMeta(editor);
  editor.doc.begin();
  editor.doc.write(row, col, null);
  if (editor.doc.commit({ before, after: before })) editor.markChanged();
}

function page(editor, e, dir) {
  e.preventDefault();
  const rowsVisible = Math.max(
    1,
    Math.floor(editor.renderer.h / editor.camera.zoom / PAIR_H),
  );
  const nr = Math.max(0, editor.cursor.row + dir * 2 * rowsVisible);
  editor.setCursor(nr, editor.cursor.col);
}

/** Keyboard zoom targets the cursor cell, so you never lose your place. */
function zoomAtCursor(editor, delta) {
  const cam = editor.camera;
  const { row, col } = editor.cursor;
  const sx = cam.toScreenX(colLeft(col) + CELL_W / 2);
  const sy = cam.toScreenY(rowTop(row) + rowHeight(row) / 2);
  cam.setZoom(cam.zoom + delta, sx, sy);
  editor.ensureCursorVisible();
  scheduleAutosave(editor);
  editor.requestRender();
}
