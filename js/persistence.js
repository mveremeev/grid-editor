// persistence.js — saving and loading. The canonical format is compact
// JSON, not plain text. Since sheets arrived the document is a workbook:
// version 2 files hold every sheet (cells + cursor + camera each); version
// 1 single-sheet files still open fine. Auto-save goes to the browser's
// local storage; explicit save/open moves real files around. Plain-text
// export is a one-way convenience, lossy by design.

import { ZOOM_MIN, ZOOM_MAX, EDGE_PAD } from './config.js';
import { rectToText } from './selection.js';
import { blobAsDataURL, importEmbeddedImages } from './images.js';

const LS_KEY = 'grid-editor.autosave.v1';
const AUTOSAVE_DELAY = 500;
const FORMAT = 'grid-editor';
const VERSION = 3;
const MAX_SHEET_NAME = 31; // same ceiling Excel uses

let autosaveTimer = 0;
let autosavePending = null; // editor with unsaved changes, if any

function sheetCells(doc) {
  // Styles pack into a bitmask; bit 0 is bold, so files saved before
  // italic/underline/strike existed load unchanged.
  const cells = [];
  for (const v of doc.cells.values()) {
    const m = (v.b ? 1 : 0) | (v.i ? 2 : 0) | (v.u ? 4 : 0) | (v.s ? 8 : 0);
    cells.push(m ? [v.r, v.c, v.ch, m] : [v.r, v.c, v.ch]);
  }
  return cells;
}

export function serialize(editor) {
  editor.syncSheet(); // fold live cursor/camera into the active record
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    view: editor.viewMode === 'paged' ? 'paged' : 'infinite',
    active: editor.sheetIndex,
    sheets: editor.sheets.map((s) => ({
      name: s.name,
      cells: sheetCells(s.doc),
      images: (s.images || []).map(
        (im) => [im.id, im.r0, im.c0, im.r1, im.c1]),
      cursor: { ...s.cursor },
      anchorCol: s.anchorCol,
      camera: { ...s.camera },
    })),
  });
}

/** Normalise one sheet's stored form into clean load data. */
function normalizeSheet(s, i) {
  const cur = (s && s.cursor) || { row: 0, col: 0 };
  const cam = (s && s.camera) || {};
  return {
    name: String((s && s.name) || `Sheet${i + 1}`).slice(0, MAX_SHEET_NAME),
    cells: (Array.isArray(s.cells) ? s.cells : []).map(([r, c, ch, m]) => ({
      r: r | 0, c: c | 0, ch: String(ch),
      b: !!(m & 1), i: !!(m & 2), u: !!(m & 4), s: !!(m & 8),
    })),
    images: (Array.isArray(s.images) ? s.images : []).map((im) => {
      const [id, r0, c0, r1, c1] = Array.isArray(im)
        ? im
        : [im.id, im.r0, im.c0, im.r1, im.c1];
      const a = Math.max(0, r0 | 0);
      const b = Math.max(0, c0 | 0);
      return {
        id: String(id),
        r0: a, c0: b,
        r1: Math.max(a, r1 | 0),
        c1: Math.max(b, c1 | 0),
      };
    }),
    cursor: {
      row: Math.max(0, cur.row | 0),
      col: Math.max(0, cur.col | 0),
    },
    anchorCol: Math.max(0, (s.anchorCol ?? cur.col) | 0),
    camera: {
      x: Math.max(-EDGE_PAD,
        Number.isFinite(+cam.x) ? +cam.x : -EDGE_PAD),
      y: Math.max(-EDGE_PAD,
        Number.isFinite(+cam.y) ? +cam.y : -EDGE_PAD),
      zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +cam.zoom || 1)),
    },
  };
}

/** Load a serialized document into the editor. Throws on bad input. */
export function restore(editor, json) {
  const data = JSON.parse(json);
  if (!data || data.format !== FORMAT) {
    throw new Error('Not a grid-editor document.');
  }
  let sheets;
  let active = 0;
  if (Array.isArray(data.sheets) && data.sheets.length) {
    sheets = data.sheets; // version 2: the whole workbook
    active = data.active | 0;
  } else if (Array.isArray(data.cells)) {
    sheets = [data]; // version 1: one sheet, fields at the top level
  } else {
    throw new Error('Not a grid-editor document.');
  }
  editor.loadWorkbook(
    sheets.map(normalizeSheet),
    Math.min(Math.max(0, active), sheets.length - 1),
    data.view === 'paged' ? 'paged' : 'infinite',
  );
  // Embedded picture bytes (from .grid files) unpack in the background;
  // frames render immediately, bitmaps follow.
  if (data.blobs && typeof data.blobs === 'object') {
    importEmbeddedImages(editor, data.blobs);
  }
}

// ---- Auto-save -------------------------------------------------------------

function autosaveNow(editor) {
  clearTimeout(autosaveTimer);
  autosavePending = null;
  try {
    localStorage.setItem(LS_KEY, serialize(editor));
    editor.setSaveState('autosaved');
  } catch {
    editor.setSaveState('unsaved'); // storage full or unavailable
  }
}

export function scheduleAutosave(editor) {
  clearTimeout(autosaveTimer);
  autosavePending = editor;
  autosaveTimer = setTimeout(() => autosaveNow(editor), AUTOSAVE_DELAY);
}

/**
 * Write any pending autosave immediately. Called on pagehide so edits made
 * in the last debounce window aren't lost when the tab closes.
 */
export function flushAutosave() {
  if (autosavePending) autosaveNow(autosavePending);
}

export function loadAutosave(editor) {
  let json = null;
  try {
    json = localStorage.getItem(LS_KEY);
  } catch {
    return false;
  }
  if (!json) return false;
  try {
    restore(editor, json);
    editor.setSaveState('autosaved');
    return true;
  } catch {
    return false;
  }
}

export function clearAutosave() {
  // Kill any pending timer too — a debounced save firing after the clear
  // would resurrect the document that was just discarded.
  clearTimeout(autosaveTimer);
  autosavePending = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch { /* unavailable */ }
}

// ---- Files -----------------------------------------------------------------

// .grid files on disk are gzip-compressed JSON: the cell-per-entry JSON
// is wonderfully regular and compresses ~10x. The payload stays ordinary
// JSON, so a .grid is still inspectable with any gunzip. Old uncompressed
// files load fine — openFile sniffs the gzip magic bytes.

/** Compress text → Blob with the browser's native gzip. */
export async function gzipText(text) {
  const stream = new Blob([text]).stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/** Decompress a gzipped Blob/File back to text. */
export async function gunzipToText(blob) {
  const stream = blob.stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function download(name, text, type) {
  downloadBlob(name, new Blob([text], { type }));
}

function currentName() {
  const input = document.getElementById('filename');
  let name = (input && input.value.trim()) || 'untitled';
  name = name.replace(/\.grid$/i, '').replace(/[\\/:*?"<>|]/g, '').trim();
  return name || 'untitled';
}

export async function saveToFile(editor) {
  const data = JSON.parse(serialize(editor));
  // Embed picture bytes so the file is the whole document.
  const ids = new Set();
  for (const s of data.sheets) {
    for (const im of s.images || []) ids.add(im[0]);
  }
  if (ids.size) {
    data.blobs = {};
    for (const id of ids) {
      try {
        const url = await blobAsDataURL(id);
        if (url) data.blobs[id] = url;
      } catch { /* missing bytes — the frame still saves */ }
    }
  }
  const json = JSON.stringify(data);
  let blob;
  try {
    blob = await gzipText(json);
  } catch {
    // No CompressionStream (very old browser) — plain JSON still works.
    blob = new Blob([json], { type: 'application/json' });
  }
  downloadBlob(currentName() + '.grid', blob);
  editor.setSaveState('saved');
}

export function openFilePicker() {
  const input = document.getElementById('file-input');
  if (input) input.click();
}

export async function openFile(editor, file) {
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const text = head[0] === 0x1f && head[1] === 0x8b
      ? await gunzipToText(file) // compressed .grid
      : await file.text();       // pre-compression .grid / plain JSON
    restore(editor, text);
    const input = document.getElementById('filename');
    if (input) input.value = file.name.replace(/\.(grid|json)$/i, '');
    scheduleAutosave(editor);
    editor.setSaveState('autosaved');
  } catch {
    alert('That file is not a grid-editor document.');
  }
}

/**
 * Plain-text export: reconstruct lines from the used range — or from just
 * the selection, when one is active. Loses zoom, seam rendering, and
 * styling — an escape hatch, not the document.
 */
export function exportText(editor) {
  let rect = editor.selection;
  if (!rect) {
    const b = editor.doc.bounds();
    rect = b
      ? { r0: 0, r1: b.maxRow, c0: 0, c1: b.maxCol }
      : { r0: 0, r1: 0, c0: 0, c1: 0 };
  } else {
    editor.flashStatus?.('Exported the selection');
  }
  download(currentName() + '.txt',
    rectToText(editor.doc, rect) + '\n', 'text/plain');
}

export function newDocument(editor) {
  const hasContent = editor.sheets.some((s) => s.doc.cells.size);
  if (hasContent &&
      !confirm('Clear the canvas? Anything not saved to a file will be lost.')) {
    return;
  }
  editor.loadWorkbook(
    [normalizeSheet({ name: 'Sheet1', cells: [] }, 0)], 0, 'paged',
  );
  clearAutosave();
  editor.setSaveState('empty');
}
