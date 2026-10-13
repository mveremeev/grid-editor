// renderer.js — draws the visible slice of the infinite grid to a single
// <canvas>. The canvas is the viewport, not the document: only cells inside
// the current view are considered each frame.

import {
  CELL_W, CELL_H, MID_H, FONT_SIZE, FONT_STACK, COLORS,
  PAGE_COLS, PAGE_ROW_SPAN, PAGE_GAP,
} from './config.js';
import { rowTop, rowHeight, rowAtY, colLeft } from './camera.js';
import { PAGE_W, PAGE_H } from './pages.js';
import { bitmapFor } from './images.js';
import { misspelled } from './spell.js';

const COARSE_ZOOM = 0.5;  // below this, draw a coarser grid
const MIN_GLYPH_PX = 6;   // below this, draw ink marks instead of glyphs

function strokeInside(ctx, x, y, w, h, lineWidth) {
  const inset = lineWidth / 2;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(
    x + inset,
    y + inset,
    Math.max(0, w - lineWidth),
    Math.max(0, h - lineWidth),
  );
}

export class Renderer {
  constructor(canvas, editor) {
    this.canvas = canvas;
    this.editor = editor;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0; // CSS-pixel viewport size
    this.h = 0;
    this.baseCanvas = document.createElement('canvas');
    this.baseCtx = this.baseCanvas.getContext('2d');
    this.baseKey = '';
    // Glyph tile cache: each unique (char, weight) is rasterised once at
    // the current zoom and blitted thereafter — drawImage is much cheaper
    // than fillText, which shapes the glyph every call.
    this.glyphCache = new Map();
    this.glyphCacheKey = '';
  }

  /** Match the backing store to the element size and device pixel ratio. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = rect.width;
    this.h = rect.height;
    const cam = this.editor.camera;
    cam.viewW = this.w;
    cam.viewH = this.h;
    cam.panBy(0, 0); // re-apply scroll limits for the new size
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.baseCanvas.width = this.canvas.width;
    this.baseCanvas.height = this.canvas.height;
    this.baseKey = '';
    this.render();
  }

  /** Snap a CSS-pixel coordinate to the device-pixel grid for crisp rules. */
  snap(v) {
    const d = this.dpr;
    return Math.round(v * d) / d + 0.5 / d;
  }

  renderBase(view) {
    const { w, h, z, wx0, wy0, c0, c1, r0, r1, sx, sy, coarse } = view;
    const ctx = this.baseCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, w, h);

    // Subtle tint on midline rows so the seam reads (and Alt+arrow has a
    // visible target).
    if (!coarse) {
      ctx.fillStyle = COLORS.midTint;
      for (let r = r0 % 2 === 0 ? r0 + 1 : r0; r <= r1; r += 2) {
        ctx.fillRect(0, sy(rowTop(r)), w, MID_H * z);
      }
    }

    // Gridlines. Coarse mode draws every 4th column and only character-row
    // boundaries, to stay fast and avoid moiré when zoomed far out.
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.gridLine;
    ctx.beginPath();
    const cStep = coarse ? 4 : 1;
    for (let c = Math.ceil(c0 / cStep) * cStep; c <= c1; c += cStep) {
      const x = this.snap(sx(colLeft(c)));
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let r = r0; r <= r1 + 1; r++) {
      if (coarse && r % 2 !== 0) continue;
      const y = this.snap(sy(rowTop(r)));
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // Off-sheet margin: the strip left of / above the origin is desk,
    // not paper — the sheet has a corner, and it isn't the window's.
    const ox = sx(0);
    const oy = sy(0);
    if (wx0 < 0) {
      ctx.fillStyle = COLORS.desk;
      ctx.fillRect(0, 0, ox, h);
    }
    if (wy0 < 0) {
      ctx.fillStyle = COLORS.desk;
      ctx.fillRect(0, 0, w, oy);
    }

    // Origin rules: the hard top-left corner is a real edge — emphasise it.
    ctx.strokeStyle = COLORS.gridStrong;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (wx0 <= 0.001) {
      ctx.moveTo(ox + 1, Math.max(0, oy));
      ctx.lineTo(ox + 1, h);
    }
    if (wy0 <= 0.001) {
      ctx.moveTo(Math.max(0, ox), oy + 1);
      ctx.lineTo(w, oy + 1);
    }
    ctx.stroke();
  }

  /** Paged view: gray desk, white page sheets, grid clipped to pages. */
  renderBasePaged(view) {
    const { w, h, z, wy0, c0, c1, r0, r1, sx, sy, coarse } = view;
    const ctx = this.baseCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.desk;
    ctx.fillRect(0, 0, w, h);

    const stride = PAGE_H + PAGE_GAP;
    const wy1 = wy0 + h / z;
    const p0 = Math.max(0, Math.floor(wy0 / stride));
    const p1 = Math.max(p0, Math.floor(wy1 / stride));
    const px = sx(0);
    const pw = PAGE_W * z;

    for (let p = p0; p <= p1; p++) {
      const py = sy(p * stride);
      const ph = PAGE_H * z;

      // The sheet itself, with a soft edge so it sits on the desk.
      ctx.save();
      ctx.shadowColor = 'rgba(28, 39, 51, 0.18)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = COLORS.paper;
      ctx.fillRect(px, py, pw, ph);
      ctx.restore();
      ctx.strokeStyle = COLORS.pageEdge;
      strokeInside(ctx, px, py, pw, ph, 1);

      // Grid inside the page only. Far out, pages read as clean paper.
      if (!coarse) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(px, py, pw, ph);
        ctx.clip();
        const ra = Math.max(r0, p * PAGE_ROW_SPAN);
        const rb = Math.min(r1, p * PAGE_ROW_SPAN + PAGE_ROW_SPAN - 1);
        ctx.fillStyle = COLORS.midTint;
        for (let r = ra % 2 === 0 ? ra + 1 : ra; r <= rb; r += 2) {
          ctx.fillRect(px, sy(rowTop(r)), pw, MID_H * z);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = COLORS.gridLine;
        ctx.beginPath();
        for (let c = Math.max(c0, 1); c <= Math.min(c1, PAGE_COLS - 1); c++) {
          const x = this.snap(sx(colLeft(c)));
          ctx.moveTo(x, py);
          ctx.lineTo(x, py + ph);
        }
        for (let r = ra; r <= rb; r++) {
          if (r === p * PAGE_ROW_SPAN) continue; // the frame is the edge
          const y = this.snap(sy(rowTop(r)));
          ctx.moveTo(px, y);
          ctx.lineTo(px + pw, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Page number, in the gap underneath.
      ctx.fillStyle = 'rgba(28, 39, 51, 0.45)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(p + 1), px + pw / 2, py + ph + 5);
    }
  }

  render() {
    const { ctx, w, h, editor } = this;
    if (!w || !h) return;
    const cam = editor.camera;
    const doc = editor.doc;
    const z = cam.zoom;

    // Visible world range → visible row/column range.
    const wx0 = cam.x, wy0 = cam.y;
    const wx1 = wx0 + w / z, wy1 = wy0 + h / z;
    const c0 = Math.max(0, Math.floor(wx0 / CELL_W));
    const c1 = Math.floor(wx1 / CELL_W) + 1;
    const r0 = Math.max(0, rowAtY(wy0));
    const r1 = rowAtY(wy1) + 1;

    const sx = v => (v - wx0) * z;
    const sy = v => (v - wy0) * z;
    const coarse = z < COARSE_ZOOM;
    const view = { w, h, z, wx0, wy0, c0, c1, r0, r1, sx, sy, coarse };
    const paged = editor.viewMode === 'paged';
    const baseKey = [
      this.canvas.width, this.canvas.height, this.dpr,
      cam.x, cam.y, z, c0, c1, r0, r1, paged ? 'p' : 'i',
    ].join(':');

    if (baseKey !== this.baseKey) {
      if (paged) this.renderBasePaged(view);
      else this.renderBase(view);
      this.baseKey = baseKey;
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.baseCanvas, 0, 0, w, h);

    // Pictures sit under the text (so cells can label them): the frame
    // snaps to the grid, the bitmap letterboxes inside it.
    for (const im of editor.images) {
      const ix = sx(colLeft(im.c0));
      const iy = sy(rowTop(im.r0));
      const iw = sx(colLeft(im.c1 + 1)) - ix;
      const ih = sy(rowTop(im.r1) + rowHeight(im.r1)) - iy;
      if (ix > w || iy > h || ix + iw < 0 || iy + ih < 0) continue;
      ctx.fillStyle = '#fff';
      ctx.fillRect(ix, iy, iw, ih);
      const bmp = bitmapFor(editor, im.id);
      if (bmp) {
        const k = Math.min(iw / bmp.width, ih / bmp.height);
        const dw = bmp.width * k;
        const dh = bmp.height * k;
        ctx.drawImage(bmp, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh);
      }
      ctx.strokeStyle = COLORS.inkFaint;
      strokeInside(ctx, ix, iy, iw, ih, 1);
    }

    // Selection fill (under the glyphs; border goes on top later).
    const sel = editor.selection;
    let selRect = null;
    if (sel) {
      const x = sx(colLeft(sel.c0));
      const y = sy(rowTop(sel.r0));
      selRect = {
        x, y,
        w: sx(colLeft(sel.c1 + 1)) - x,
        h: sy(rowTop(sel.r1) + rowHeight(sel.r1)) - y,
      };
      if (editor.float) {
        // A floating block hovers: white card with a soft shadow, so
        // "not dropped yet" is visible at a glance.
        ctx.save();
        ctx.shadowColor = 'rgba(28, 39, 51, 0.3)';
        ctx.shadowBlur = 9;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = COLORS.paper;
        ctx.fillRect(selRect.x, selRect.y, selRect.w, selRect.h);
        ctx.restore();
      }
      ctx.fillStyle = COLORS.selFill;
      ctx.fillRect(selRect.x, selRect.y, selRect.w, selRect.h);
    }

    // Find highlights (under the glyphs): every match when highlight-all
    // is on, otherwise just the current one.
    const find = editor.find;
    if (find && find.matches.length) {
      ctx.fillStyle = COLORS.findFill;
      for (let i = 0; i < find.matches.length; i++) {
        if (!find.highlightAll && i !== find.index) continue;
        const m = find.matches[i];
        if (m.r < r0 || m.r > r1 || m.c1 < c0 || m.c0 > c1) continue;
        ctx.fillRect(
          sx(colLeft(m.c0)), sy(rowTop(m.r)),
          (m.c1 - m.c0 + 1) * CELL_W * z, rowHeight(m.r) * z,
        );
      }
    }

    // Cell cursor geometry.
    const cur = editor.cursor;
    const curX = sx(colLeft(cur.col));
    const curY = sy(rowTop(cur.row));
    const curW = CELL_W * z;
    const curH = rowHeight(cur.row) * z;

    // Cells to draw. During a floating block move, cells at the block's
    // origin are lifted (hidden) and cells under its current position are
    // occluded; the floating snapshot draws at its offset instead. The
    // document itself is untouched until the move is confirmed.
    let list = doc.cellsInRect(r0, r1, c0, c1);
    const float = editor.float;
    let floatList = null;
    if (float) {
      // Ghost floats (paste, copy-drag) have no lifted source — only the
      // destination occludes. Real moves also hide the origin cells.
      const inRect = (v, rc) => rc &&
        v.r >= rc.r0 && v.r <= rc.r1 && v.c >= rc.c0 && v.c <= rc.c1;
      list = list.filter(v =>
        !(!float.ghost && inRect(v, float.rect0)) && !inRect(v, sel));
      floatList = [];
      for (const it of float.items) {
        const r = it.r + float.dr;
        const c = it.c + float.dc;
        if (r >= r0 && r <= r1 && c >= c0 && c <= c1) {
          floatList.push({ r, c, ch: it.ch, b: it.b });
        }
      }
    }

    // Glyph pass. Below MIN_GLYPH_PX, draw small ink rectangles instead —
    // a minimap-like impression of where content is.
    const fontPx = FONT_SIZE * z;
    if (fontPx >= MIN_GLYPH_PX) {
      this.drawGlyphs(ctx, list, z, fontPx, sx, sy);
      if (floatList) {
        ctx.save();
        ctx.globalAlpha = 0.65; // floating content reads as a preview
        this.drawGlyphs(ctx, floatList, z, fontPx, sx, sy);
        ctx.restore();
      }
    } else {
      ctx.fillStyle = COLORS.inkFaint;
      const marks = (arr) => {
        for (const v of arr) {
          const cw = CELL_W * z, chh = rowHeight(v.r) * z;
          ctx.fillRect(
            sx(colLeft(v.c)) + cw * 0.2,
            sy(rowTop(v.r)) + chh * 0.2,
            cw * 0.6,
            chh * 0.6,
          );
        }
      };
      marks(list);
      if (floatList) {
        ctx.save();
        ctx.globalAlpha = 0.65;
        marks(floatList);
        ctx.restore();
      }
    }

    // Spelling squiggles, when checking is on and glyphs are readable.
    if (editor.spell && editor.spell.ready && fontPx >= MIN_GLYPH_PX) {
      this.drawSpelling(ctx, r0, r1, c0, c1, z, sx, sy);
    }

    // Drop / undo-landing flash: a brief green wash that fades out.
    const flash = editor.flash;
    if (flash) {
      const t = (flash.until - performance.now()) / flash.dur;
      if (t <= 0) {
        editor.flash = null;
      } else {
        const fx = sx(colLeft(flash.rect.c0));
        const fy = sy(rowTop(flash.rect.r0));
        ctx.save();
        ctx.globalAlpha = 0.3 * t;
        ctx.fillStyle = flash.color || COLORS.accent;
        ctx.fillRect(fx, fy,
          sx(colLeft(flash.rect.c1 + 1)) - fx,
          sy(rowTop(flash.rect.r1) + rowHeight(flash.rect.r1)) - fy);
        ctx.restore();
        editor.requestRender(); // keep fading
      }
    }

    // The current find match gets its own border above the glyphs.
    if (find && find.index >= 0 && find.matches[find.index]) {
      const m = find.matches[find.index];
      if (!(m.r < r0 || m.r > r1 || m.c1 < c0 || m.c0 > c1)) {
        ctx.strokeStyle = COLORS.findEdge;
        strokeInside(ctx,
          sx(colLeft(m.c0)), sy(rowTop(m.r)),
          (m.c1 - m.c0 + 1) * CELL_W * z, rowHeight(m.r) * z, 2);
      }
    }

    // Cursor outline + selection border on top of everything. An active
    // style pen thickens the cursor — visible where you're looking.
    const pen = editor.pen;
    const penOn = pen && (pen.b || pen.i || pen.u || pen.s);
    ctx.strokeStyle = COLORS.accent;
    strokeInside(ctx, curX, curY, curW, curH, penOn ? 3.5 : 2);
    if (selRect) {
      ctx.strokeStyle = COLORS.accent;
      strokeInside(ctx, selRect.x, selRect.y, selRect.w, selRect.h, 1.5);
    }

    // The selected image: accent frame and corner handles.
    const imSel = editor.imageSel;
    if (imSel && editor.images.includes(imSel)) {
      const ix = sx(colLeft(imSel.c0));
      const iy = sy(rowTop(imSel.r0));
      const iw = sx(colLeft(imSel.c1 + 1)) - ix;
      const ih = sy(rowTop(imSel.r1) + rowHeight(imSel.r1)) - iy;
      ctx.strokeStyle = COLORS.accent;
      strokeInside(ctx, ix, iy, iw, ih, 2);
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 1.5;
      for (const [hx, hy] of [
        [ix, iy], [ix + iw, iy], [ix, iy + ih], [ix + iw, iy + ih],
      ]) {
        ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
        ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
      }
    }

    // Marching ants around a copied source, until Esc or the next edit.
    const ants = editor.ants;
    if (ants) {
      const ax = sx(colLeft(ants.c0));
      const ay = sy(rowTop(ants.r0));
      const aw = sx(colLeft(ants.c1 + 1)) - ax;
      const ah = sy(rowTop(ants.r1) + rowHeight(ants.r1)) - ay;
      ctx.save();
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.lineDashOffset = -((performance.now() / 40) % 8);
      ctx.strokeRect(
        ax + 0.75, ay + 0.75,
        Math.max(0, aw - 1.5), Math.max(0, ah - 1.5),
      );
      ctx.restore();
      editor.requestRender(); // keep the ants marching
    }
  }

  /**
   * Red squiggles under unrecognised words: contiguous letter runs on
   * character rows, checked against the loaded dictionary.
   */
  drawSpelling(ctx, r0, r1, c0, c1, z, sx, sy) {
    const ed = this.editor;
    const dict = ed.spell.dict;
    ctx.save();
    ctx.strokeStyle = COLORS.squiggle;
    ctx.lineWidth = Math.max(1, 1.1 * z);
    ctx.beginPath();
    for (let r = r0 % 2 === 0 ? r0 : r0 + 1; r <= r1; r += 2) {
      const cells = ed.doc.rowCells(r);
      let run = null; // { c0, c1, word }
      const flush = () => {
        if (run) {
          if (run.c1 >= c0 && run.c0 <= c1 &&
              misspelled(dict, run.word.toLowerCase())) {
            this.squiggle(ctx,
              sx(colLeft(run.c0)), sx(colLeft(run.c1 + 1)),
              sy(rowTop(r) + CELL_H - 2.5), z);
          }
          run = null;
        }
      };
      for (const v of cells) {
        if (/[A-Za-z']/.test(v.ch)) {
          if (run && v.c === run.c1 + 1) {
            run.c1 = v.c;
            run.word += v.ch;
          } else {
            flush();
            run = { c0: v.c, c1: v.c, word: v.ch };
          }
        } else {
          flush();
        }
      }
      flush();
    }
    ctx.stroke();
    ctx.restore();
  }

  /** One zigzag underline from x0 to x1 at screen-space y. */
  squiggle(ctx, x0, x1, y, z) {
    const s = Math.max(0.7, z);
    const amp = 1.3 * s;
    const step = 3.2 * s;
    let up = false;
    ctx.moveTo(x0, y);
    for (let x = x0 + step; x < x1 + step; x += step) {
      ctx.lineTo(Math.min(x, x1), y + (up ? -amp : amp));
      up = !up;
    }
  }

  /**
   * Draw the visible glyphs. At a steady zoom each unique character is
   * rasterised once into a tile and blitted; while the zoom is actively
   * changing (fontPx differs from last frame) we draw with fillText and
   * skip tile building, so a pinch never thrashes the cache.
   */
  /** The CSS font for a cell's style at a given size. */
  static cellFont(v, fontPx) {
    return (v.i ? 'italic ' : '') + (v.b ? '700 ' : '400 ') +
      fontPx + 'px ' + FONT_STACK;
  }

  drawGlyphs(ctx, list, z, fontPx, sx, sy) {
    const cellW = CELL_W * z;
    const th = Math.max(1, fontPx * 0.07); // underline/strike thickness
    const key = fontPx + ':' + this.dpr;
    if (key !== this.glyphCacheKey) {
      this.glyphCacheKey = key;
      this.glyphCache.clear();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.ink;
      let lastFont = '';
      for (const v of list) {
        const f = Renderer.cellFont(v, fontPx);
        if (f !== lastFont) {
          ctx.font = f;
          lastFont = f;
        }
        const x0 = sx(colLeft(v.c));
        const cy = sy(rowTop(v.r)) + (rowHeight(v.r) * z) / 2;
        // Midline glyphs centre on the thin row and are allowed to
        // overflow into the rows above/below — that's the point.
        ctx.fillText(v.ch, x0 + cellW / 2, cy);
        if (v.s) ctx.fillRect(x0, cy - th / 2, cellW, th);
        if (v.u) ctx.fillRect(x0, cy + fontPx * 0.42, cellW, th);
      }
      return;
    }
    for (const v of list) {
      const t = this.glyphTile(v, fontPx);
      ctx.drawImage(
        t.canvas,
        sx(colLeft(v.c)) + cellW / 2 - t.w / 2,
        sy(rowTop(v.r)) + (rowHeight(v.r) * z) / 2 - t.h / 2,
        t.w,
        t.h,
      );
    }
  }

  /** Tile for one (char, style) at the current zoom — built on demand.
   *  Underline/strike are baked in at cell width, so neighbouring
   *  decorated cells join into one continuous line. */
  glyphTile(v, fontPx) {
    const key = (v.b ? 'b' : '') + (v.i ? 'i' : '') +
      (v.u ? 'u' : '') + (v.s ? 's' : '') + ':' + v.ch;
    let tile = this.glyphCache.get(key);
    if (tile) return tile;
    if (this.glyphCache.size >= 512) this.glyphCache.clear();
    // Generous box: glyphs (especially on midlines) may overflow the cell.
    const css = Math.ceil(fontPx * 2);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(css * this.dpr));
    cv.height = cv.width;
    const tctx = cv.getContext('2d');
    tctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    tctx.font = Renderer.cellFont(v, fontPx);
    tctx.textAlign = 'center';
    tctx.textBaseline = 'middle';
    tctx.fillStyle = COLORS.ink;
    const mid = css / 2;
    tctx.fillText(v.ch, mid, mid);
    if (v.u || v.s) {
      const cellW = CELL_W * (fontPx / FONT_SIZE);
      const th = Math.max(1, fontPx * 0.07);
      if (v.s) tctx.fillRect(mid - cellW / 2, mid - th / 2, cellW, th);
      if (v.u) {
        tctx.fillRect(mid - cellW / 2, mid + fontPx * 0.42, cellW, th);
      }
    }
    tile = { canvas: cv, w: css, h: css };
    this.glyphCache.set(key, tile);
    return tile;
  }
}
