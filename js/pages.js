// pages.js — everything "page"-shaped: the A4 page geometry, the
// overflow check and rewrap used when switching to paged view, and the
// print pipeline (each page rendered to an offscreen canvas and handed
// to the browser as an image, so printing shows pages — not the app).

import {
  CELL_W, CELL_H, PAIR_H, FONT_SIZE, FONT_STACK,
  PAGE_COLS, PAGE_ROW_SPAN,
} from './config.js';
import { rowTop, rowHeight, colLeft } from './camera.js';
import { cachedBitmap } from './images.js';

/** Row top in raw (gap-free) coordinates — print pages have no gaps,
 *  and image frames may hang off a page edge (negative local rows). */
function rawRowTop(r) {
  return r % 2 === 0
    ? (r / 2) * PAIR_H
    : ((r - 1) / 2) * PAIR_H + CELL_H;
}

export const PAGE_W = PAGE_COLS * CELL_W;            // 980 world px
export const PAGE_H = (PAGE_ROW_SPAN / 2) * PAIR_H;  // 1440 world px

/** True if any cell sits to the right of the page margin. */
export function docOverflowsWidth(doc, width = PAGE_COLS) {
  for (const v of doc.cells.values()) {
    if (v.c >= width) return true;
  }
  return false;
}

/**
 * Wrap everything wider than `width` columns: each row's overflow is cut
 * at the margin and carried onto continuation rows of the same parity
 * below it (columns keep their position modulo the width, so blocks stay
 * internally aligned). Rows further down shift to make room — the one
 * operation in the app that moves content the user didn't move, which is
 * why the caller wraps it in a single undo batch.
 *
 * Opens a batch and stages the writes; returns true if anything moved
 * (the caller commits), false if the document already fits.
 */
export function rewrapDoc(doc, width = PAGE_COLS) {
  const rows = Array.from(doc.rows.keys()).sort((a, b) => a - b);
  const moves = [];
  let shift = 0;
  for (const r of rows) {
    let maxChunk = 0;
    for (const v of doc.rowCells(r)) {
      const chunk = Math.floor(v.c / width);
      if (chunk > maxChunk) maxChunk = chunk;
      moves.push({
        fr: v.r, fc: v.c,
        r: r + shift + 2 * chunk, c: v.c % width,
        ch: v.ch, b: v.b,
      });
    }
    shift += 2 * maxChunk;
  }
  if (moves.every((m) => m.fr === m.r && m.fc === m.c)) return false;
  doc.begin();
  // Clear every old position first, then write every new one — the two
  // passes keep movers from trampling each other.
  for (const m of moves) doc.write(m.fr, m.fc, null);
  for (const m of moves) doc.write(m.r, m.c, { ch: m.ch, b: m.b });
  return true;
}

/**
 * Render the active sheet into print-page <img> elements inside
 * `container`. Paged view prints its pages exactly (off-page content is
 * off the page); infinite view is sliced into page-width bands, top to
 * bottom then left to right, skipping empty ones. Glyphs only — the
 * grid is chrome, paper is paper.
 */
export function buildPrintPages(editor, container) {
  container.textContent = '';
  const doc = editor.doc;
  const b = doc.bounds();
  const SCALE = 2; // crisp on paper

  const addPage = (cells, rBase, cBase) => {
    const cv = document.createElement('canvas');
    cv.width = PAGE_W * SCALE;
    cv.height = PAGE_H * SCALE;
    const ctx = cv.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    // Pictures first, under the text, clipped by the page edges.
    for (const im of editor.images) {
      const x = colLeft(im.c0 - cBase);
      const y = rawRowTop(im.r0 - rBase);
      const iw = colLeft(im.c1 + 1 - cBase) - x;
      const ih = rawRowTop(im.r1 - rBase) + rowHeight(im.r1) - y;
      if (x > PAGE_W || y > PAGE_H || x + iw < 0 || y + ih < 0) continue;
      const bmp = cachedBitmap(im.id);
      if (bmp) {
        const k = Math.min(iw / bmp.width, ih / bmp.height);
        const dw = bmp.width * k;
        const dh = bmp.height * k;
        ctx.drawImage(bmp, x + (iw - dw) / 2, y + (ih - dh) / 2, dw, dh);
      }
      ctx.strokeStyle = 'rgba(17, 17, 17, 0.35)';
      ctx.lineWidth = 0.75;
      ctx.strokeRect(x + 0.375, y + 0.375, iw - 0.75, ih - 0.75);
    }
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let lastFont = '';
    for (const v of cells) {
      const lr = v.r - rBase;
      const lc = v.c - cBase;
      if (lr < 0 || lr >= PAGE_ROW_SPAN || lc < 0 || lc >= PAGE_COLS) {
        continue;
      }
      const f = (v.i ? 'italic ' : '') + (v.b ? '700 ' : '400 ') +
        FONT_SIZE + 'px ' + FONT_STACK;
      if (f !== lastFont) {
        ctx.font = f;
        lastFont = f;
      }
      // Local rows are < PAGE_ROW_SPAN, so rowTop never adds a page gap.
      const x0 = colLeft(lc);
      const cy = rowTop(lr) + rowHeight(lr) / 2;
      ctx.fillText(v.ch, x0 + CELL_W / 2, cy);
      const th = Math.max(1, FONT_SIZE * 0.07);
      if (v.s) ctx.fillRect(x0, cy - th / 2, CELL_W, th);
      if (v.u) ctx.fillRect(x0, cy + FONT_SIZE * 0.42, CELL_W, th);
    }
    const img = document.createElement('img');
    img.className = 'print-page';
    img.alt = '';
    img.src = cv.toDataURL('image/png');
    container.appendChild(img);
  };

  if (!b) {
    addPage([], 0, 0); // an empty sheet still prints one blank page
    return;
  }
  if (editor.viewMode === 'paged') {
    const pages = Math.floor(b.maxRow / PAGE_ROW_SPAN) + 1;
    for (let p = 0; p < pages; p++) {
      const r0 = p * PAGE_ROW_SPAN;
      addPage(
        doc.cellsInRect(r0, r0 + PAGE_ROW_SPAN - 1, 0, PAGE_COLS - 1),
        r0, 0,
      );
    }
  } else {
    const rBands = Math.floor(b.maxRow / PAGE_ROW_SPAN) + 1;
    const cBands = Math.floor(b.maxCol / PAGE_COLS) + 1;
    let any = false;
    for (let rb = 0; rb < rBands; rb++) {
      for (let cb = 0; cb < cBands; cb++) {
        const cells = doc.cellsInRect(
          rb * PAGE_ROW_SPAN, rb * PAGE_ROW_SPAN + PAGE_ROW_SPAN - 1,
          cb * PAGE_COLS, cb * PAGE_COLS + PAGE_COLS - 1,
        );
        if (cells.length) {
          addPage(cells, rb * PAGE_ROW_SPAN, cb * PAGE_COLS);
          any = true;
        }
      }
    }
    if (!any) addPage([], 0, 0);
  }
}
