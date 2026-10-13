// mouse.js — everything the keyboard can do, the mouse can drive too.
// Click selects the cell under the pointer (that becomes the cursor),
// drag or Shift+click makes a rectangular selection, double-click grabs
// the word and triple-click the row, Alt/Option+drag inside a selection
// moves the block (floating, like arrow nudges), Ctrl/Cmd+drag drags a
// copy, right-click cancels a float or opens the context menu, wheel
// pans, Ctrl/Cmd+wheel zooms toward the pointer, middle-drag pans.

import { ZOOM_WHEEL_RATE, CELL_W, PAIR_H, PAGE_COLS } from './config.js';
import { rowAtY, colAtX } from './camera.js';
import {
  rectFrom, commitFloat, cancelFloat, nudgeSelection, liftCopy,
} from './selection.js';
import { imageAt, imageHandleAt, commitImageRect } from './images.js';
import { scheduleAutosave } from './persistence.js';

const AUTOPAN_RATE = 0.22; // px of pan per px of overshoot, per frame

export function installMouse(editor) {
  const canvas = editor.canvas;
  let dragStart = null;   // cell where a left-drag began
  let dragMoved = false;
  let panLast = null;     // screen point for middle-drag panning
  let blockDrag = null;   // Alt/Cmd-drag of the selected block (world anchor)
  let imgDrag = null;     // moving or resizing an image frame
  let pointerRect = null;
  let lastClient = null;  // last pointer position, for edge auto-pan
  let autopan = 0;        // rAF id while auto-panning

  function cellAt(p) {
    const rect = pointerRect || canvas.getBoundingClientRect();
    const sx = p.clientX - rect.left;
    const sy = p.clientY - rect.top;
    const cam = editor.camera;
    let col = colAtX(cam.toWorldX(sx));
    // In paged view the pointer maps to page cells only — dragging onto
    // the desk can't select past the margin.
    if (editor.viewMode === 'paged') col = Math.min(col, PAGE_COLS - 1);
    return {
      row: rowAtY(Math.max(0, cam.toWorldY(sy))),
      col,
    };
  }

  /** Extend the drag-selection to the cell under a client point. */
  function updateDragSelection(p) {
    const cell = cellAt(p);
    if (!dragMoved &&
        cell.row === dragStart.row && cell.col === dragStart.col) {
      return;
    }
    if (dragMoved &&
        cell.row === editor.cursor.row && cell.col === editor.cursor.col) {
      return;
    }
    dragMoved = true;
    editor.selectingDrag = true; // name box reads out the size meanwhile
    editor.selAnchor = { ...dragStart };
    editor.selection = rectFrom(dragStart, cell);
    editor.cursor = { row: cell.row, col: cell.col };
    editor.requestRender();
  }

  /** Keep panning while a drag-selection is held past the viewport edge. */
  function autopanStep() {
    autopan = 0;
    if (!dragStart || !lastClient) return;
    const rect = pointerRect || canvas.getBoundingClientRect();
    let dx = 0, dy = 0;
    if (lastClient.x < rect.left) dx = lastClient.x - rect.left;
    else if (lastClient.x > rect.right) dx = lastClient.x - rect.right;
    if (lastClient.y < rect.top) dy = lastClient.y - rect.top;
    else if (lastClient.y > rect.bottom) dy = lastClient.y - rect.bottom;
    if (!dx && !dy) return;
    editor.camera.panBy(dx * AUTOPAN_RATE, dy * AUTOPAN_RATE);
    updateDragSelection({ clientX: lastClient.x, clientY: lastClient.y });
    scheduleAutosave(editor);
    editor.requestRender();
    autopan = requestAnimationFrame(autopanStep);
  }

  canvas.addEventListener('pointerdown', (e) => {
    // One gesture at a time — a second pointer (touch, stray button) mid-
    // drag would corrupt the gesture state.
    if (panLast || blockDrag || dragStart || imgDrag) return;
    canvas.focus();
    editor.ui.hideContextMenu?.();
    pointerRect = canvas.getBoundingClientRect();
    if (e.button === 1) {
      // Middle-drag pan.
      e.preventDefault();
      panLast = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    const cell = cellAt(e);

    // Alt/Option+drag inside the selection picks the block up and moves
    // it; Ctrl/Cmd+drag picks up a *copy*. Both are the same floating
    // move as arrow nudges: drop on Enter/click, cancel on Escape.
    const sel = editor.selection;
    const inSel = sel &&
      cell.row >= sel.r0 && cell.row <= sel.r1 &&
      cell.col >= sel.c0 && cell.col <= sel.c1;
    const wantsCopy = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    const wantsMove = e.altKey && !e.shiftKey;
    if (inSel && (wantsMove || wantsCopy)) {
      e.preventDefault();
      if (wantsCopy) liftCopy(editor); // no-op if a float is already up
      const cam = editor.camera;
      blockDrag = {
        wx0: cam.toWorldX(e.clientX - pointerRect.left),
        wy0: cam.toWorldY(e.clientY - pointerRect.top),
        dr: 0, // cell offset applied so far during this drag
        dc: 0,
      };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }

    // Plain clicks meet pictures before cells: a corner handle starts a
    // resize, anywhere else on the frame starts a move. Clicking empty
    // grid deselects and falls through to normal cursor placement.
    if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const cam = editor.camera;
      const wx = cam.toWorldX(e.clientX - pointerRect.left);
      const wy = cam.toWorldY(e.clientY - pointerRect.top);
      const selImg = editor.imageSel;
      const handle = selImg && editor.images.includes(selImg)
        ? imageHandleAt(editor, selImg, wx, wy)
        : null;
      const hit = handle ? selImg : imageAt(editor, wx, wy);
      if (hit) {
        e.preventDefault();
        commitFloat(editor);
        editor.imageSel = hit;
        editor.selection = null;
        editor.selAnchor = null;
        imgDrag = {
          img: hit,
          mode: handle || 'move',
          startCell: cell,
          orig: { r0: hit.r0, c0: hit.c0, r1: hit.r1, c1: hit.c1 },
        };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = handle ? 'nwse-resize' : 'move';
        editor.requestRender();
        return;
      }
      if (selImg) {
        editor.imageSel = null; // click-away deselects, then place cursor
        editor.requestRender();
      }
    }

    if (e.shiftKey) {
      e.preventDefault();
      commitFloat(editor); // resizing confirms any move in progress
      const anchor = editor.selAnchor || { ...editor.cursor };
      editor.selAnchor = anchor;
      editor.selection = rectFrom(anchor, cell);
      editor.cursor = { row: cell.row, col: cell.col };
      editor.anchorCol = cell.col;
      editor.ensureCursorVisible();
      editor.requestRender();
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Double-click selects the word under the pointer; triple-click the
    // whole row's content.
    if (e.detail === 2 || e.detail === 3) {
      const run = e.detail === 2
        ? editor.doc.runAt(cell.row, cell.col)
        : editor.doc.rowExtent(cell.row);
      if (run) {
        commitFloat(editor);
        editor.selAnchor = { row: cell.row, col: run.c0 };
        editor.selection =
          { r0: cell.row, r1: cell.row, c0: run.c0, c1: run.c1 };
        editor.cursor = { row: cell.row, col: run.c1 };
        editor.anchorCol = run.c0;
        editor.requestRender();
        return;
      }
    }

    dragStart = cell;
    dragMoved = false;
    editor.setCursor(cell.row, cell.col); // also clears any selection
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const last = events && events.length ? events[events.length - 1] : e;
    if (panLast) {
      editor.camera.panBy(panLast.x - last.clientX, panLast.y - last.clientY);
      panLast = { x: last.clientX, y: last.clientY };
      scheduleAutosave(editor);
      editor.requestRender();
      return;
    }
    if (imgDrag) {
      const cell = cellAt(last);
      const img = imgDrag.img;
      const o = imgDrag.orig;
      if (imgDrag.mode === 'move') {
        let ddr = cell.row - imgDrag.startCell.row;
        let ddc = cell.col - imgDrag.startCell.col;
        ddr = Math.max(ddr, -o.r0);
        ddc = Math.max(ddc, -o.c0);
        if (editor.viewMode === 'paged') {
          ddc = Math.min(ddc, PAGE_COLS - 1 - o.c1);
        }
        img.r0 = o.r0 + ddr;
        img.r1 = o.r1 + ddr;
        img.c0 = o.c0 + ddc;
        img.c1 = o.c1 + ddc;
      } else {
        // Corner resize: the dragged corner follows the pointer cell.
        const m = imgDrag.mode;
        if (m === 'nw' || m === 'ne') {
          img.r0 = Math.max(0, Math.min(o.r1, cell.row));
        } else {
          img.r1 = Math.max(o.r0, cell.row);
        }
        if (m === 'nw' || m === 'sw') {
          img.c0 = Math.max(0, Math.min(o.c1, cell.col));
        } else {
          img.c1 = Math.max(o.c0, cell.col);
        }
      }
      editor.requestRender();
      return;
    }
    if (blockDrag) {
      const sel = editor.selection;
      if (!sel) {
        blockDrag = null;
        return;
      }
      const rect = pointerRect || canvas.getBoundingClientRect();
      const cam = editor.camera;
      const wx = cam.toWorldX(last.clientX - rect.left);
      const wy = cam.toWorldY(last.clientY - rect.top);
      // Total offset the pointer asks for (rows snap in pairs, so the
      // block keeps its row parity — Alt+arrows still do single rows),
      // minus what's already applied, clamped per-axis at the origin.
      let ddr = Math.round((wy - blockDrag.wy0) / PAIR_H) * 2 - blockDrag.dr;
      let ddc = Math.round((wx - blockDrag.wx0) / CELL_W) - blockDrag.dc;
      ddr = Math.max(ddr, -sel.r0);
      ddc = Math.max(ddc, -sel.c0);
      if (editor.viewMode === 'paged') {
        // Dragged blocks slide along the margin, never onto the desk.
        ddc = Math.min(ddc, PAGE_COLS - 1 - sel.c1);
      }
      if (ddr || ddc) {
        nudgeSelection(editor, ddr, ddc);
        blockDrag.dr += ddr;
        blockDrag.dc += ddc;
      }
      return;
    }
    if (!dragStart) return;
    lastClient = { x: last.clientX, y: last.clientY };
    updateDragSelection(last);
    // Past the canvas edge, keep scrolling toward the pointer.
    const rect = pointerRect || canvas.getBoundingClientRect();
    const outside =
      last.clientX < rect.left || last.clientX > rect.right ||
      last.clientY < rect.top || last.clientY > rect.bottom;
    if (outside && !autopan) autopan = requestAnimationFrame(autopanStep);
  });

  function endPointer(e) {
    if (imgDrag) {
      commitImageRect(editor, imgDrag.img, imgDrag.orig);
      imgDrag = null;
      canvas.style.cursor = '';
    }
    if (panLast || blockDrag) {
      panLast = null;
      blockDrag = null; // the block stays floating: Enter drops, Esc cancels
      canvas.style.cursor = '';
    }
    dragStart = null;
    lastClient = null;
    pointerRect = null;
    if (autopan) {
      cancelAnimationFrame(autopan);
      autopan = 0;
    }
    if (editor.selectingDrag) {
      editor.selectingDrag = false; // name box returns to the cell ref
      editor.requestRender();
    }
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Right-click: mid-move it cancels the float (sends the block home);
  // otherwise it opens the context menu. Like Excel, right-clicking
  // outside the selection moves the cursor there first — so Paste lands
  // where you clicked, not where the cursor happened to be.
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (cancelFloat(editor)) return;
    pointerRect = canvas.getBoundingClientRect();
    const cell = cellAt(e);
    pointerRect = null;
    const sel = editor.selection;
    const inSel = sel &&
      cell.row >= sel.r0 && cell.row <= sel.r1 &&
      cell.col >= sel.c0 && cell.col <= sel.c1;
    if (!inSel) editor.setCursor(cell.row, cell.col);
    editor.ui.showContextMenu?.(e.clientX, e.clientY);
  });

  // Block the middle-click autoscroll widget so middle-drag panning works.
  canvas.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (e.ctrlKey || e.metaKey) {
      // Zoom toward the pointer (also catches trackpad pinch).
      editor.camera.zoomBy(Math.exp(-dy * ZOOM_WHEEL_RATE), sx, sy);
    } else if (e.shiftKey) {
      // Shift turns a vertical wheel into horizontal panning.
      editor.camera.panBy(dy + dx, 0);
    } else {
      editor.camera.panBy(dx, dy);
    }
    scheduleAutosave(editor);
    editor.requestRender();
  }, { passive: false });
}
