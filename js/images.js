// images.js — embedded pictures. An image is a frame snapped to the
// cell grid ({id, r0, c0, r1, c1} on its sheet) with the bitmap
// letterboxed inside; only the frame ever snaps, never the pixels.
// Bytes live in IndexedDB (no localStorage quota worries); .grid files
// embed them as data URLs so documents stay portable.

import { CELL_W, PAIR_H, PAGE_COLS } from './config.js';
import { rowTop, rowHeight, colLeft } from './camera.js';

const DB_NAME = 'grid-editor';
const STORE = 'images';
const MAX_DIM = 1500; // imports are downscaled to keep files sane

// ---- IndexedDB -------------------------------------------------------------

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  return dbPromise;
}

function done(rq) {
  return new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function blobStore(mode) {
  const d = await db();
  return d.transaction(STORE, mode).objectStore(STORE);
}

export async function putBlob(id, blob) {
  return done((await blobStore('readwrite')).put(blob, id));
}

export async function getBlob(id) {
  return done((await blobStore('readonly')).get(id));
}

export async function deleteBlob(id) {
  return done((await blobStore('readwrite')).delete(id));
}

/** Drop stored blobs nothing references any more (run at workbook load,
 *  when undo history is empty and can't resurrect them). */
export async function gcBlobs(referenced) {
  try {
    const keys = await done((await blobStore('readonly')).getAllKeys());
    for (const k of keys) {
      if (!referenced.has(k)) await deleteBlob(k);
    }
  } catch { /* storage unavailable — nothing to clean */ }
}

// ---- Decoded bitmap cache ----------------------------------------------------

const bitmaps = new Map(); // id → ImageBitmap, or 'loading'

/** The decoded bitmap, or null while it loads (a render follows). */
export function bitmapFor(editor, id) {
  const b = bitmaps.get(id);
  if (b && b !== 'loading') return b;
  if (!b) {
    bitmaps.set(id, 'loading');
    getBlob(id).then(async (blob) => {
      if (!blob) {
        bitmaps.delete(id);
        return;
      }
      bitmaps.set(id, await createImageBitmap(blob));
      editor.requestRender();
    }).catch(() => bitmaps.delete(id));
  }
  return null;
}

/** Cache-only lookup (printing can't wait on loads). */
export function cachedBitmap(id) {
  const b = bitmaps.get(id);
  return b && b !== 'loading' ? b : null;
}

// ---- Import ------------------------------------------------------------------

/** Decode, downscale to MAX_DIM, store; returns {id, width, height}. */
async function importBlob(blob) {
  const src = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_DIM / Math.max(src.width, src.height));
  let outBlob = blob;
  let outBmp = src;
  if (scale < 1 || !/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(src.width * scale));
    cv.height = Math.max(1, Math.round(src.height * scale));
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    outBlob = await new Promise((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))),
        type, 0.85);
    });
    outBmp = await createImageBitmap(outBlob);
  }
  const id = 'img-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 8);
  await putBlob(id, outBlob);
  bitmaps.set(id, outBmp);
  return { id, width: outBmp.width, height: outBmp.height };
}

function imageMeta(editor) {
  return {
    row: editor.cursor.row,
    col: editor.cursor.col,
    anchor: editor.anchorCol,
  };
}

const rectOf = (im) => ({ r0: im.r0, c0: im.c0, r1: im.r1, c1: im.c1 });

/**
 * Import a picture and place its frame at a cell: ~30 columns wide,
 * rows matched to the bitmap's aspect, clamped onto the page in paged
 * view. One undoable batch; the new image arrives selected.
 */
export async function insertImage(editor, blob, at) {
  let info;
  try {
    info = await importBlob(blob);
  } catch {
    editor.flashStatus?.("Couldn't read that image");
    return;
  }
  let cols = 30;
  let c0 = Math.max(0, at.col);
  if (editor.viewMode === 'paged') {
    cols = Math.min(cols, PAGE_COLS);
    c0 = Math.min(c0, PAGE_COLS - cols);
  }
  const r0 = Math.max(0, at.row - (at.row % 2)); // frames start on a pair
  const worldH = cols * CELL_W * (info.height / info.width);
  const pairs = Math.max(1, Math.round(worldH / PAIR_H));
  const img = {
    id: info.id,
    r0,
    c0,
    r1: r0 + pairs * 2 - 1,
    c1: c0 + cols - 1,
  };
  const meta = imageMeta(editor);
  editor.images.push(img);
  editor.doc.begin();
  editor.doc.imageOp({
    arr: editor.images, img, before: null, after: rectOf(img),
  });
  editor.doc.commit({ before: meta, after: meta });
  editor.imageSel = img;
  editor.markChanged();
}

/** Remove an image (one undo step; the bytes stay until the next GC). */
export function deleteImage(editor, img) {
  const i = editor.images.indexOf(img);
  if (i < 0) return;
  const meta = imageMeta(editor);
  editor.images.splice(i, 1);
  editor.doc.begin();
  editor.doc.imageOp({
    arr: editor.images, img, before: rectOf(img), after: null,
  });
  editor.doc.commit({ before: meta, after: meta });
  if (editor.imageSel === img) editor.imageSel = null;
  editor.markChanged();
}

/** Nudge a selected image by whole cells (arrow keys). */
export function moveImage(editor, img, dr, dc) {
  if (img.r0 + dr < 0 || img.c0 + dc < 0) {
    editor.flashStatus?.('Edge of sheet');
    return;
  }
  if (editor.viewMode === 'paged' && img.c1 + dc > PAGE_COLS - 1) {
    editor.flashStatus?.('Edge of page');
    return;
  }
  const before = rectOf(img);
  img.r0 += dr; img.r1 += dr;
  img.c0 += dc; img.c1 += dc;
  commitImageRect(editor, img, before);
}

/** Record an already-applied frame change as one undo step. */
export function commitImageRect(editor, img, before) {
  if (before.r0 === img.r0 && before.c0 === img.c0 &&
      before.r1 === img.r1 && before.c1 === img.c1) {
    return;
  }
  const meta = imageMeta(editor);
  editor.doc.begin();
  editor.doc.imageOp({
    arr: editor.images, img, before, after: rectOf(img),
  });
  editor.doc.commit({ before: meta, after: meta });
  editor.markChanged();
}

// ---- Hit testing ---------------------------------------------------------------

/** Topmost image whose frame contains the world point. */
export function imageAt(editor, wx, wy) {
  for (let i = editor.images.length - 1; i >= 0; i--) {
    const im = editor.images[i];
    if (wx >= colLeft(im.c0) && wx < colLeft(im.c1 + 1) &&
        wy >= rowTop(im.r0) &&
        wy < rowTop(im.r1) + rowHeight(im.r1)) {
      return im;
    }
  }
  return null;
}

/** Which resize handle (if any) of an image the world point touches. */
export function imageHandleAt(editor, im, wx, wy) {
  const tol = 7 / editor.camera.zoom;
  const x0 = colLeft(im.c0);
  const x1 = colLeft(im.c1 + 1);
  const y0 = rowTop(im.r0);
  const y1 = rowTop(im.r1) + rowHeight(im.r1);
  const near = (a, b) => Math.abs(a - b) <= tol;
  if (near(wx, x0) && near(wy, y0)) return 'nw';
  if (near(wx, x1) && near(wy, y0)) return 'ne';
  if (near(wx, x0) && near(wy, y1)) return 'sw';
  if (near(wx, x1) && near(wy, y1)) return 'se';
  return null;
}

// ---- File embedding --------------------------------------------------------------

/** A stored blob as a data URL, for embedding in .grid files. */
export async function blobAsDataURL(id) {
  const blob = await getBlob(id);
  if (!blob) return null;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Unpack data URLs from an opened .grid back into the blob store. */
export async function importEmbeddedImages(editor, blobs) {
  for (const [id, url] of Object.entries(blobs)) {
    try {
      const blob = await (await fetch(url)).blob();
      await putBlob(id, blob);
      bitmaps.delete(id);
      bitmapFor(editor, id); // decode now; renders when ready
    } catch { /* skip a corrupt entry rather than fail the file */ }
  }
}
