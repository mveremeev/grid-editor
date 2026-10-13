// test/run.mjs — headless checks for the pure-logic modules (doc,
// selection, camera). No DOM, no canvas: run with `npm test`.

import { GridDoc } from '../js/doc.js';
import {
  nudgeSelection, commitFloat, cancelFloat, clearSelection, paste,
  liftCopy, toggleStyleSelection,
} from '../js/selection.js';
import {
  Camera, rowTop, rowHeight, rowAtY, colLeft, colAtX, setPagedRows,
} from '../js/camera.js';
import { docOverflowsWidth, rewrapDoc } from '../js/pages.js';
import { misspelled } from '../js/spell.js';
import { findMatches } from '../js/find.js';
import {
  serialize, restore, gzipText, gunzipToText,
} from '../js/persistence.js';

// selection.js touches navigator.clipboard (guarded with &&); older Node
// has no navigator global at all, so give it an empty one.
if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
  });
}

let passed = 0;
let failed = 0;

function ok(cond, name) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('FAIL: ' + name);
  }
}

function eq(a, b, name) {
  ok(Object.is(a, b), name + ' (got ' + JSON.stringify(a) +
    ', want ' + JSON.stringify(b) + ')');
}

function makeEditor() {
  const doc = new GridDoc();
  return {
    doc,
    cursor: { row: 0, col: 0 },
    anchorCol: 0,
    selection: null,
    selAnchor: null,
    float: null,
    ants: null,
    viewMode: 'infinite',
    clipboard: null,
    boldPen: false,
    markChanged() { this.ants = null; },
    requestRender() {},
    ensureCursorVisible() {},
  };
}

function put(doc, r, c, ch, b = false) {
  doc.begin();
  doc.write(r, c, { ch, b });
  doc.commit();
}

const chAt = (doc, r, c) => {
  const v = doc.get(r, c);
  return v ? v.ch : null;
};

// ---- Floating moves --------------------------------------------------------

{
  // Mid-move, content the block passes over is only occluded, never erased.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a');
  put(ed.doc, 0, 4, 'x'); // bystander in the path
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 0 };
  ed.cursor = { row: 0, col: 0 };
  nudgeSelection(ed, 0, 4); // float lands on top of 'x'
  eq(chAt(ed.doc, 0, 4), 'x', 'pass-over: doc untouched mid-move');
  eq(chAt(ed.doc, 0, 0), 'a', 'pass-over: source untouched mid-move');
  ok(ed.float && ed.float.dc === 4, 'pass-over: float carries the offset');
}

{
  // Drop clears the entire destination rectangle — preview is the contract.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a'); // block: 1×2 with a hole at (0,1)
  put(ed.doc, 0, 5, 'q'); // sits where the hole will land
  put(ed.doc, 0, 4, 'x'); // sits where 'a' will land
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 1 };
  nudgeSelection(ed, 0, 4);
  commitFloat(ed);
  eq(chAt(ed.doc, 0, 4), 'a', 'drop: block written at destination');
  eq(chAt(ed.doc, 0, 5), null, 'drop: hole in the block clears beneath it');
  eq(chAt(ed.doc, 0, 0), null, 'drop: source erased');
}

{
  // Cancel: block returns home, no doc change, cursor restored.
  const ed = makeEditor();
  put(ed.doc, 2, 3, 'm');
  ed.cursor = { row: 2, col: 3 };
  ed.anchorCol = 3;
  ed.selection = { r0: 2, r1: 2, c0: 3, c1: 3 };
  const depth = ed.doc.undoStack.length;
  nudgeSelection(ed, 2, 1);
  cancelFloat(ed);
  eq(chAt(ed.doc, 2, 3), 'm', 'cancel: content back at origin');
  eq(ed.doc.undoStack.length, depth, 'cancel: no undo entry');
  eq(ed.cursor.row, 2, 'cancel: cursor row restored');
  eq(ed.cursor.col, 3, 'cancel: cursor col restored');
  ok(!ed.selection && !ed.float, 'cancel: selection and float dismissed');
}

{
  // The whole move (any number of nudges) is ONE undo batch.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a');
  put(ed.doc, 0, 1, 'b');
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 1 };
  const depth = ed.doc.undoStack.length;
  nudgeSelection(ed, 0, 1);
  nudgeSelection(ed, 2, 0);
  nudgeSelection(ed, 0, 2);
  commitFloat(ed);
  eq(ed.doc.undoStack.length, depth + 1, 'move: single undo batch');
  ed.doc.undo();
  eq(chAt(ed.doc, 0, 0), 'a', 'move: undo restores source a');
  eq(chAt(ed.doc, 0, 1), 'b', 'move: undo restores source b');
  eq(chAt(ed.doc, 2, 3), null, 'move: undo clears destination');
}

{
  // A refused nudge at the origin must not create a phantom float.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a');
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 0 };
  nudgeSelection(ed, -2, 0); // refused: already at row 0
  eq(ed.float, null, 'clamp: refused first nudge creates no float');
  nudgeSelection(ed, 0, -1); // refused: already at col 0
  eq(ed.float, null, 'clamp: refused horizontal nudge creates no float');
  nudgeSelection(ed, 0, 1);
  nudgeSelection(ed, 0, -1);
  nudgeSelection(ed, 0, -1); // refused: would cross the origin mid-move
  ok(ed.float && ed.float.dc === 0, 'clamp: mid-move refusal keeps offset');
}

{
  // Moving out and back is a no-op: no doc change, no undo entry.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a');
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 0 };
  const depth = ed.doc.undoStack.length;
  nudgeSelection(ed, 0, 3);
  nudgeSelection(ed, 0, -3);
  const changed = commitFloat(ed);
  eq(changed, false, 'round-trip: commit reports no change');
  eq(ed.doc.undoStack.length, depth, 'round-trip: no undo entry');
  eq(chAt(ed.doc, 0, 0), 'a', 'round-trip: content untouched');
}

// ---- Clipboard & clearing --------------------------------------------------

{
  // Paste is a preview: a ghost float, no doc change until confirmed.
  // On confirm it claims its whole rectangle — pre-existing content
  // inside the block's bounds is cleared, even under holes.
  const ed = makeEditor();
  put(ed.doc, 0, 1, 'z'); // will sit under the hole in the pasted block
  put(ed.doc, 0, 2, 'y'); // will sit under a pasted character
  ed.clipboard = {
    rows: 1,
    cols: 3,
    items: [
      { dr: 0, dc: 0, ch: 'p', b: false },
      { dr: 0, dc: 2, ch: 'q', b: false }, // hole at dc 1
    ],
  };
  ed.cursor = { row: 0, col: 0 };
  await paste(ed);
  ok(ed.float && ed.float.ghost, 'paste: arrives as a ghost float');
  eq(chAt(ed.doc, 0, 1), 'z', 'paste: doc untouched while previewing');
  ok(ed.selection && ed.selection.c1 === 2, 'paste: block becomes selection');
  commitFloat(ed);
  eq(chAt(ed.doc, 0, 0), 'p', 'paste: confirmed block written');
  eq(chAt(ed.doc, 0, 1), null, 'paste: hole clears beneath it');
  eq(chAt(ed.doc, 0, 2), 'q', 'paste: block overwrites');
}

{
  // Cancelling a paste preview leaves no trace at all.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'x');
  ed.clipboard = {
    rows: 1, cols: 1, items: [{ dr: 0, dc: 0, ch: 'p', b: false }],
  };
  ed.cursor = { row: 0, col: 0 };
  const depth = ed.doc.undoStack.length;
  await paste(ed);
  cancelFloat(ed);
  eq(chAt(ed.doc, 0, 0), 'x', 'paste-cancel: doc untouched');
  eq(ed.doc.undoStack.length, depth, 'paste-cancel: no undo entry');
  eq(ed.float, null, 'paste-cancel: float dismissed');
}

{
  // Copy-drag: a ghost lift drops a duplicate and keeps the source.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a');
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 0 };
  liftCopy(ed);
  ok(ed.float && ed.float.ghost, 'copy-drag: ghost float lifted');
  nudgeSelection(ed, 0, 3);
  eq(chAt(ed.doc, 0, 0), 'a', 'copy-drag: source intact mid-drag');
  commitFloat(ed);
  eq(chAt(ed.doc, 0, 0), 'a', 'copy-drag: source survives the drop');
  eq(chAt(ed.doc, 0, 3), 'a', 'copy-drag: duplicate written');
}

{
  // Clearing an empty selection reports no change (cursor stays put).
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a');
  ed.selection = { r0: 4, r1: 6, c0: 4, c1: 6 }; // empty region
  eq(clearSelection(ed), false, 'clear: empty selection is a no-op');
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 0 };
  eq(clearSelection(ed), true, 'clear: populated selection reports change');
  eq(chAt(ed.doc, 0, 0), null, 'clear: content erased');
}

// ---- Styles -------------------------------------------------------------------

{
  // Toggling one style leaves the others alone, and round-trips.
  const ed = makeEditor();
  put(ed.doc, 0, 0, 'a', true); // bold already
  put(ed.doc, 0, 1, 'b');
  ed.selection = { r0: 0, r1: 0, c0: 0, c1: 1 };
  toggleStyleSelection(ed, 'i');
  ok(ed.doc.get(0, 0).i && ed.doc.get(0, 1).i, 'styles: italic applied');
  ok(ed.doc.get(0, 0).b, 'styles: bold preserved through italic toggle');
  toggleStyleSelection(ed, 'i');
  ok(!ed.doc.get(0, 0).i, 'styles: italic toggles back off');
  toggleStyleSelection(ed, 'u');
  toggleStyleSelection(ed, 's');
  ok(ed.doc.get(0, 1).u && ed.doc.get(0, 1).s,
    'styles: underline and strike stack');
}

{
  // A style-only change is a real change (undoable), and styles persist
  // through the file format's bitmask.
  const doc = new GridDoc();
  put(doc, 0, 0, 'a');
  doc.begin();
  doc.write(0, 0, { ch: 'a', u: true });
  eq(doc.commit(), true, 'styles: style-only write registers as a change');
  doc.undo();
  ok(!doc.get(0, 0).u, 'styles: undo removes the style');

  const styled = new GridDoc();
  styled.load([{ r: 0, c: 0, ch: 'x', b: true, i: true, s: true }]);
  const ed = {
    sheets: [{ name: 'S', doc: styled, cursor: { row: 0, col: 0 },
      anchorCol: 0, camera: { x: 0, y: 0, zoom: 1 } }],
    sheetIndex: 0,
    viewMode: 'infinite',
    syncSheet() {},
    loaded: null,
    loadWorkbook(sheets, active, view) { this.loaded = { sheets }; },
  };
  restore(ed, serialize(ed));
  const cell = ed.loaded.sheets[0].cells[0];
  ok(cell.b && cell.i && cell.s && !cell.u,
    'styles: bitmask survives the file round trip');
}

// ---- Image frame ops in the undo stack -------------------------------------

{
  const doc = new GridDoc();
  const arr = [];
  const img = { id: 'pic', r0: 0, c0: 0, r1: 3, c1: 9 };

  // add
  arr.push(img);
  doc.begin();
  doc.imageOp({ arr, img, before: null, after: { r0: 0, c0: 0, r1: 3, c1: 9 } });
  eq(doc.commit(), true, 'images: an image-only batch commits');

  // move (mutation applied by the caller, op records before/after)
  doc.begin();
  doc.imageOp({
    arr, img,
    before: { r0: 0, c0: 0, r1: 3, c1: 9 },
    after: { r0: 4, c0: 5, r1: 7, c1: 14 },
  });
  img.r0 = 4; img.c0 = 5; img.r1 = 7; img.c1 = 14;
  doc.commit();

  // mixed batch: a cell write and a delete together
  doc.begin();
  doc.write(0, 0, { ch: 'x', b: false });
  arr.splice(arr.indexOf(img), 1);
  doc.imageOp({
    arr, img, before: { r0: 4, c0: 5, r1: 7, c1: 14 }, after: null,
  });
  doc.commit();
  eq(arr.length, 0, 'images: delete leaves the sheet empty');

  doc.undo();
  eq(arr.length, 1, 'images: undo restores the deleted image');
  eq(doc.get(0, 0), null, 'images: the same undo reverts the cell write');
  eq(img.r0, 4, 'images: restored frame keeps its last position');
  doc.undo();
  eq(img.r0, 0, 'images: undoing the move restores the old frame');
  doc.undo();
  eq(arr.length, 0, 'images: undoing the add removes it');
  doc.redo();
  eq(arr.length, 1, 'images: redo re-adds');
  doc.redo();
  eq(img.c0, 5, 'images: redo re-moves');
  doc.redo();
  eq(arr.length, 0, 'images: redo re-deletes');
}

{
  // Image metadata survives the file round trip (bytes ride separately).
  const doc = new GridDoc();
  const ed = {
    sheets: [{
      name: 'S', doc,
      images: [{ id: 'pic-1', r0: 2, c0: 3, r1: 9, c1: 32 }],
      cursor: { row: 0, col: 0 }, anchorCol: 0,
      camera: { x: 0, y: 0, zoom: 1 },
    }],
    sheetIndex: 0,
    viewMode: 'infinite',
    syncSheet() {},
    loaded: null,
    loadWorkbook(sheets) { this.loaded = sheets; },
  };
  restore(ed, serialize(ed));
  const im = ed.loaded[0].images[0];
  ok(im && im.id === 'pic-1' && im.r0 === 2 && im.c1 === 32,
    'images: frame metadata survives serialize/restore');
}

// ---- Document batching -----------------------------------------------------

{
  // begin() while a batch is open merges instead of dropping changes.
  const doc = new GridDoc();
  doc.begin();
  doc.write(0, 0, { ch: 'a', b: false });
  doc.begin(); // re-entrant begin — must not discard the recorded write
  doc.write(0, 1, { ch: 'b', b: false });
  doc.commit();
  eq(doc.undoStack.length, 1, 'begin-merge: one batch');
  doc.undo();
  eq(doc.get(0, 0), null, 'begin-merge: undo reverts first write');
  eq(doc.get(0, 1), null, 'begin-merge: undo reverts second write');
}

{
  // Writes that change nothing don't create an undo entry.
  const doc = new GridDoc();
  put(doc, 0, 0, 'a');
  const depth = doc.undoStack.length;
  doc.begin();
  doc.write(0, 0, { ch: 'a', b: false }); // identical
  doc.write(-1, 0, { ch: 'x', b: false }); // out of bounds
  eq(doc.commit(), false, 'no-op writes: commit reports no change');
  eq(doc.undoStack.length, depth, 'no-op writes: no undo entry');
}

// ---- Content navigation -----------------------------------------------------

{
  const doc = new GridDoc();
  // row 0: "ab" at 0-1, gap, "cd" at 5-6
  put(doc, 0, 0, 'a'); put(doc, 0, 1, 'b');
  put(doc, 0, 5, 'c'); put(doc, 0, 6, 'd');
  eq(doc.nextEdgeCol(0, 0, 1), 1, 'edge: inside a run → its far end');
  eq(doc.nextEdgeCol(0, 1, 1), 5, 'edge: from a run end → next run');
  eq(doc.nextEdgeCol(0, 3, 1), 5, 'edge: from a gap → next filled');
  eq(doc.nextEdgeCol(0, 6, 1), 6, 'edge: nothing ahead → stay');
  eq(doc.nextEdgeCol(0, 5, -1), 1, 'edge: leftward to previous run');
  eq(doc.nextEdgeCol(0, 1, -1), 0, 'edge: inside run leftward → start');
  eq(doc.nextEdgeCol(0, 0, -1), 0, 'edge: at origin → origin');
  eq(doc.nextEdgeCol(2, 4, -1), 0, 'edge: empty row leftward → col 0');
  // column 0: rows 0, 4 filled (character rows)
  put(doc, 4, 0, 'e');
  eq(doc.nextEdgeRow(0, 0, 1), 4, 'edge: down to the next filled row');
  eq(doc.nextEdgeRow(4, 0, -1), 0, 'edge: up to the previous filled row');
  eq(doc.nextEdgeRow(4, 0, 1), 4, 'edge: nothing below → stay');
}

{
  const doc = new GridDoc();
  put(doc, 0, 3, 'w'); put(doc, 0, 4, 'o'); put(doc, 0, 5, 'w');
  put(doc, 0, 9, 'x');
  const run = doc.runAt(0, 4);
  ok(run && run.c0 === 3 && run.c1 === 5, 'runAt: finds the word run');
  eq(doc.runAt(0, 7), null, 'runAt: empty cell → null');
  const ext = doc.rowExtent(0);
  ok(ext && ext.c0 === 3 && ext.c1 === 9, 'rowExtent: full content span');
}

// ---- Zoom snap & edge padding --------------------------------------------------

{
  const cam = new Camera();
  cam.setZoom(1.01, 0, 0);
  eq(cam.zoom, 1, 'zoom: 101% snaps home to 100%');
  cam.setZoom(1.1, 0, 0);
  eq(cam.zoom, 1.1, 'zoom: 110% stays put');
}

{
  const cam = new Camera();
  eq(cam.x, -36, 'camera: starts with the origin inset from the edge');
  cam.panBy(-10000, -10000);
  eq(cam.x, -36, 'camera: panning stops at the edge padding');
  eq(cam.y, -36, 'camera: vertically too');
}

{
  // Paged view: horizontal scrolling stops at the page's right edge.
  const cam = new Camera();
  cam.viewW = 500;
  setPagedRows(80);
  cam.panBy(100000, 0);
  eq(cam.x, 70 * 14 + 36 - 500, 'paged camera: right scroll limit');
  cam.panBy(0, 100000);
  ok(cam.y > 10000, 'paged camera: vertical scroll stays free');
  setPagedRows(0);
  cam.panBy(100000, 0);
  ok(cam.x > 10000, 'infinite camera: no right scroll limit');
}

// ---- Spelling ----------------------------------------------------------------

{
  const dict = new Set(['hello', 'cat']);
  eq(misspelled(dict, 'hello'), false, 'spell: known word passes');
  eq(misspelled(dict, 'helo'), true, 'spell: unknown word flagged');
  eq(misspelled(dict, "cat's"), false, 'spell: possessive checks the stem');
  eq(misspelled(dict, 'x'), false, 'spell: single letters never flagged');
}

// ---- Find ---------------------------------------------------------------------

{
  const doc = new GridDoc();
  // "the cat sat" on row 0 — the spaces are real gaps, never stored
  const s = 'the cat sat';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') put(doc, 0, i, s[i]);
  }
  put(doc, 2, 0, 'C'); put(doc, 2, 1, 'a'); put(doc, 2, 2, 't');

  let m = findMatches(doc, 'cat');
  eq(m.length, 2, 'find: case-insensitive by default');
  ok(m[0].r === 0 && m[0].c0 === 4 && m[0].c1 === 6,
    'find: match rect lands on the right cells');
  eq(findMatches(doc, 'cat', { matchCase: true }).length, 1,
    'find: match case filters');
  eq(findMatches(doc, 'at', { wholeWord: true }).length, 0,
    'find: whole words rejects partial hits');
  eq(findMatches(doc, 'cat', { wholeWord: true }).length, 2,
    'find: whole words keeps real words');
  eq(findMatches(doc, 'cat sat').length, 1,
    'find: gaps between characters read as spaces');
  eq(findMatches(doc, '').length, 0, 'find: empty query matches nothing');
  const sorted = findMatches(doc, 'a');
  ok(sorted.every((v, i) => i === 0 ||
    sorted[i - 1].r < v.r ||
    (sorted[i - 1].r === v.r && sorted[i - 1].c0 < v.c0)),
  'find: matches sorted by row, then column');
}

// ---- Paged mode ----------------------------------------------------------------

{
  // Rewrap: overflow cut at the margin, carried down, later rows shifted.
  const doc = new GridDoc();
  const s = 'abcdefgh'; // row 0, cols 0-7 — two chunks at width 4
  for (let i = 0; i < s.length; i++) put(doc, 0, i, s[i]);
  put(doc, 1, 5, '=');  // midline overflow wraps too, keeping parity
  put(doc, 2, 0, 'z');  // below: must shift down past the continuations

  ok(docOverflowsWidth(doc, 4), 'pages: overflow detected');
  ok(!docOverflowsWidth(doc, 100), 'pages: no false positives');

  const depth = doc.undoStack.length;
  const before = { row: 0, col: 0, anchor: 0 };
  ok(rewrapDoc(doc, 4), 'pages: rewrap reports movement');
  doc.commit({ before, after: before });
  eq(doc.undoStack.length, depth + 1, 'pages: rewrap is one undo batch');

  eq(chAt(doc, 0, 0), 'a', 'pages: first chunk stays put');
  eq(chAt(doc, 0, 3), 'd', 'pages: first chunk ends at the margin');
  eq(chAt(doc, 2, 0), 'e', 'pages: overflow lands on the next row');
  eq(chAt(doc, 2, 3), 'h', 'pages: overflow keeps column alignment');
  eq(chAt(doc, 5, 1), '=', 'pages: midline overflow keeps its parity');
  eq(chAt(doc, 6, 0), 'z', 'pages: rows below shift down');

  doc.undo();
  eq(chAt(doc, 0, 7), 'h', 'pages: undo restores the original layout');
  eq(chAt(doc, 2, 0), 'z', 'pages: undo restores shifted rows');
}

{
  // A document that already fits is left completely alone.
  const doc = new GridDoc();
  put(doc, 0, 0, 'a');
  eq(rewrapDoc(doc, 70), false, 'pages: no overflow → no rewrap');
  eq(doc._pending, null, 'pages: no dangling batch either');
}

{
  // Paged row math: a gap opens between pages and clicks in it resolve
  // to the next page's top row.
  setPagedRows(80);
  eq(rowTop(0), 0, 'paged camera: first page starts at 0');
  eq(rowTop(80), 1464, 'paged camera: second page after the gap');
  eq(rowAtY(1464), 80, 'paged camera: page-two top maps back');
  eq(rowAtY(1450), 80, 'paged camera: the gap belongs to the next page');
  eq(rowAtY(1439), 79, 'paged camera: last row of page one');
  let good = true;
  for (let r = 0; r < 200; r++) {
    if (rowAtY(rowTop(r)) !== r) good = false;
  }
  ok(good, 'paged camera: rowTop/rowAtY round-trip across pages');
  setPagedRows(0); // back to infinite for the remaining tests
}

// ---- Paged-view block containment ----------------------------------------------

{
  // Nudging a block past the page margin is refused in paged view.
  const ed = makeEditor();
  ed.viewMode = 'paged';
  put(ed.doc, 0, 69, 'a');
  ed.selection = { r0: 0, r1: 0, c0: 69, c1: 69 };
  nudgeSelection(ed, 0, 1);
  eq(ed.float, null, 'paged: nudge onto the desk refused, no float');
  nudgeSelection(ed, 2, 0);
  ok(ed.float && ed.float.dr === 2, 'paged: vertical nudges still free');
  cancelFloat(ed);
}

{
  // Paste wraps at the page margin, like typing it would have.
  const ed = makeEditor();
  ed.viewMode = 'paged';
  ed.clipboard = {
    rows: 1, cols: 5,
    items: [
      { dr: 0, dc: 0, ch: 'a', b: false },
      { dr: 0, dc: 1, ch: 'b', b: false },
      { dr: 0, dc: 3, ch: 'c', b: false }, // crosses the margin
      { dr: 0, dc: 4, ch: 'd', b: false },
    ],
  };
  ed.cursor = { row: 0, col: 68 };
  await paste(ed);
  ok(ed.float && ed.float.ghost, 'paged paste: still a preview');
  ok(ed.selection && ed.selection.r1 === 2,
    'paged paste: preview spans the wrapped rows');
  commitFloat(ed);
  eq(chAt(ed.doc, 0, 68), 'a', 'paged paste: start stays at the cursor');
  eq(chAt(ed.doc, 0, 69), 'b', 'paged paste: fills to the margin');
  eq(chAt(ed.doc, 2, 1), 'c', 'paged paste: overflow wraps below');
  eq(chAt(ed.doc, 2, 2), 'd', 'paged paste: wrap keeps column rhythm');
}

{
  // A multi-row block wraps row by row, later rows shifting down.
  const ed = makeEditor();
  ed.viewMode = 'paged';
  ed.clipboard = {
    rows: 3, cols: 4,
    items: [
      { dr: 0, dc: 0, ch: 'p', b: false },
      { dr: 0, dc: 3, ch: 'q', b: false }, // first row overflows
      { dr: 2, dc: 0, ch: 'z', b: false }, // second row must shift down
    ],
  };
  ed.cursor = { row: 0, col: 67 };
  await paste(ed);
  commitFloat(ed);
  eq(chAt(ed.doc, 0, 67), 'p', 'paged paste: row one in place');
  eq(chAt(ed.doc, 2, 0), 'q', 'paged paste: row one overflow wraps');
  eq(chAt(ed.doc, 4, 67), 'z', 'paged paste: later rows shift past it');
}

// ---- Workbook persistence ----------------------------------------------------

{
  const docA = new GridDoc();
  docA.load([{ r: 0, c: 0, ch: 'a', b: false }]);
  const docB = new GridDoc();
  docB.load([{ r: 2, c: 3, ch: 'b', b: true }]);
  const ed = {
    sheets: [
      { name: 'Sheet1', doc: docA, cursor: { row: 0, col: 1 },
        anchorCol: 0, camera: { x: 0, y: 0, zoom: 1 } },
      { name: 'Notes', doc: docB, cursor: { row: 2, col: 3 },
        anchorCol: 3, camera: { x: 10, y: 20, zoom: 2 } },
    ],
    sheetIndex: 1,
    viewMode: 'paged',
    syncSheet() {},
    loaded: null,
    loadWorkbook(sheets, active, view) {
      this.loaded = { sheets, active, view };
    },
  };
  restore(ed, serialize(ed));
  eq(ed.loaded.active, 1, 'workbook: active sheet survives the round trip');
  eq(ed.loaded.view, 'paged', 'workbook: view mode survives the round trip');
  eq(ed.loaded.sheets.length, 2, 'workbook: both sheets restored');
  eq(ed.loaded.sheets[1].name, 'Notes', 'workbook: names kept');
  ok(ed.loaded.sheets[1].cells.some((c) => c.ch === 'b' && c.b),
    'workbook: bold cell kept');

  // Version 1 single-sheet files still open.
  const v1 = JSON.stringify({
    format: 'grid-editor', version: 1,
    cells: [[0, 0, 'z']],
    cursor: { row: 0, col: 0 }, anchorCol: 0,
    camera: { x: 0, y: 0, zoom: 1 },
  });
  restore(ed, v1);
  eq(ed.loaded.sheets.length, 1, 'workbook: v1 file becomes one sheet');
  eq(ed.loaded.sheets[0].cells[0].ch, 'z', 'workbook: v1 cells load');
}

// ---- File compression --------------------------------------------------------

{
  const json = JSON.stringify({
    format: 'grid-editor',
    cells: Array.from({ length: 500 }, (_, i) => [0, i, 'x']),
  });
  const blob = await gzipText(json);
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  ok(head[0] === 0x1f && head[1] === 0x8b, 'gzip: magic bytes present');
  ok(blob.size < json.length / 5, 'gzip: file shrinks substantially');
  eq(await gunzipToText(blob), json, 'gzip: round trip is lossless');
}

// ---- Camera row math -------------------------------------------------------

{
  let good = true;
  for (let r = 0; r < 12; r++) {
    if (rowAtY(rowTop(r)) !== r) good = false;
    if (rowAtY(rowTop(r) + rowHeight(r) - 0.01) !== r) good = false;
  }
  ok(good, 'camera: rowTop/rowAtY round-trip over both parities');
  let goodCols = true;
  for (let c = 0; c < 12; c++) {
    if (colAtX(colLeft(c)) !== c) goodCols = false;
  }
  ok(goodCols, 'camera: colLeft/colAtX round-trip');
}

// ----------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
