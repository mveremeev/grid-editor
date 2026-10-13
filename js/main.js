// main.js — the Editor object (shared state) and the wiring between the
// document, camera, renderer, inputs, chrome, and persistence. Since
// sheets arrived the editor is a small workbook: each sheet keeps its own
// document (with undo history), cursor, and camera; the tabs at the
// bottom switch between them.

import {
  CELL_W, CELL_H, ZOOM_KEY_STEP, PAGE_COLS, PAGE_ROW_SPAN, EDGE_PAD,
} from './config.js';
import {
  Camera, rowTop, rowHeight, rowAtY, colLeft, colAtX, setPagedRows,
} from './camera.js';
import {
  docOverflowsWidth, rewrapDoc, buildPrintPages,
} from './pages.js';
import { insertImage, bitmapFor, gcBlobs } from './images.js';
import { GridDoc } from './doc.js';
import { Renderer } from './renderer.js';
import { installKeyboard } from './keyboard.js';
import { installMouse } from './mouse.js';
import {
  commitFloat, cutSelection, copySelection, paste, clearSelection,
  toggleStyleSelection,
} from './selection.js';
import { initHelp } from './help.js';
import { findMatches } from './find.js';
import { loadDict } from './spell.js';
import {
  scheduleAutosave, flushAutosave, loadAutosave, saveToFile,
  openFilePicker, openFile, exportText, newDocument,
} from './persistence.js';

const FLASH_MS = 450;
const STATUS_MSG_MS = 2200;

function blankSheet(name) {
  return {
    name,
    doc: new GridDoc(),
    images: [],
    cursor: { row: 0, col: 0 },
    anchorCol: 0,
    camera: { x: -EDGE_PAD, y: -EDGE_PAD, zoom: 1 },
  };
}

class Editor {
  constructor(canvas) {
    this.canvas = canvas;
    this.sheets = [blankSheet('Sheet1')];
    this.sheetIndex = 0;
    this.doc = this.sheets[0].doc;
    this.images = this.sheets[0].images;
    this.imageSel = null;      // the selected picture, if any
    this.camera = new Camera();
    this.cursor = { row: 0, col: 0 };
    this.anchorCol = 0;        // column Enter returns to
    this.selection = null;     // {r0, c0, r1, c1} or null
    this.selAnchor = null;     // fixed corner while extending a selection
    this.selectingDrag = false; // true mid drag-select (name box size)
    // The style pen: Ctrl/Cmd+B/I/U/5 with no selection toggle these,
    // and new typing picks them up.
    this.pen = { b: false, i: false, u: false, s: false };
    this.clipboard = null;     // internal rectangular block clipboard
    this.float = null;         // in-progress block move (see selection.js)
    this.ants = null;          // marching-ants rect after a copy
    this.flash = null;         // fading highlight rect (drop, undo)
    this.find = null;          // open find state (query, matches, ...)
    this.viewMode = 'paged';   // pages by default; 'infinite' opts out
    setPagedRows(PAGE_ROW_SPAN);
    this.spell = { on: false, ready: false, dict: null };
    this.renderer = new Renderer(canvas, this);
    this._raf = 0;
    this._statusMsg = null;
    this._statusTimer = 0;
    this.ui = buildChrome(this);
    this.ui.renderTabs();
    this.ui.updateViewButtons();
  }

  // ---- Sheets ---------------------------------------------------------------

  /** Fold the live cursor/camera back into the active sheet's record. */
  syncSheet() {
    const s = this.sheets[this.sheetIndex];
    s.cursor = { ...this.cursor };
    s.anchorCol = this.anchorCol;
    s.camera = {
      x: this.camera.x,
      y: this.camera.y,
      zoom: this.camera.zoom,
    };
  }

  /** Make the sheet at `i` the live one (its record → editor state). */
  _loadActive() {
    const s = this.sheets[this.sheetIndex];
    this.doc = s.doc;
    this.images = s.images;
    this.imageSel = null;
    this.cursor = { ...s.cursor };
    this.anchorCol = s.anchorCol;
    this.camera.x = s.camera.x;
    this.camera.y = s.camera.y;
    this.camera.zoom = s.camera.zoom;
    this.selection = null;
    this.selAnchor = null;
    this.float = null;
    this.ants = null;
    this.flash = null;
    this.ui.closeFind?.(); // stale matches don't outlive their sheet
    this.ui.renderTabs();
    this.requestRender();
  }

  activateSheet(i) {
    if (i === this.sheetIndex || i < 0 || i >= this.sheets.length) return;
    commitFloat(this);
    this.syncSheet();
    this.sheetIndex = i;
    this._loadActive();
    scheduleAutosave(this);
  }

  addSheet() {
    commitFloat(this);
    this.syncSheet();
    let n = this.sheets.length + 1;
    while (this.sheets.some((s) => s.name === `Sheet${n}`)) n++;
    this.sheets.push(blankSheet(`Sheet${n}`));
    this.sheetIndex = this.sheets.length - 1;
    this._loadActive();
    scheduleAutosave(this);
  }

  renameSheet(i, name) {
    name = name.trim().slice(0, 31);
    const taken = this.sheets.some((s, j) => j !== i && s.name === name);
    if (name && taken) this.flashStatus('That sheet name is already used');
    else if (name) this.sheets[i].name = name;
    this.ui.renderTabs();
    scheduleAutosave(this);
  }

  deleteSheet(i) {
    if (this.sheets.length <= 1) {
      this.flashStatus('A workbook needs at least one sheet');
      return;
    }
    const s = this.sheets[i];
    if (s.doc.cells.size &&
        !confirm(`Delete ${s.name}? Its contents will be lost.`)) {
      return;
    }
    if (i !== this.sheetIndex) this.syncSheet();
    this.sheets.splice(i, 1);
    if (this.sheetIndex >= i) {
      this.sheetIndex = Math.max(0, Math.min(
        this.sheetIndex === i ? i : this.sheetIndex - 1,
        this.sheets.length - 1,
      ));
    }
    this._loadActive();
    scheduleAutosave(this);
  }

  /** Replace the whole workbook (open/new/autosave restore). */
  loadWorkbook(sheets, active, view = 'infinite') {
    this.sheets = sheets.map((d) => {
      const doc = new GridDoc();
      doc.load(d.cells);
      return {
        name: d.name,
        doc,
        images: d.images || [],
        cursor: d.cursor,
        anchorCol: d.anchorCol,
        camera: d.camera,
      };
    });
    this.sheetIndex = active;
    // Warm the bitmap cache and sweep stored blobs nothing references
    // (history is empty right after a load, so nothing can revive them).
    const referenced = new Set();
    for (const s of this.sheets) {
      for (const im of s.images) {
        referenced.add(im.id);
        bitmapFor(this, im.id);
      }
    }
    gcBlobs(referenced);
    this.viewMode = view;
    setPagedRows(view === 'paged' ? PAGE_ROW_SPAN : 0);
    this.ui.updateViewButtons?.();
    this.pen = { b: false, i: false, u: false, s: false };
    this._loadActive();
  }

  /** Flip between the infinite canvas and A4 pages (view-level only —
   *  any rewrap confirmation/transformation happens in the chrome). */
  setViewMode(mode) {
    if (mode === this.viewMode) return;
    commitFloat(this);
    this.viewMode = mode;
    setPagedRows(mode === 'paged' ? PAGE_ROW_SPAN : 0);
    this.camera.panBy(0, 0); // re-apply the paged scroll limits
    this.ui.updateViewButtons?.();
    this.ensureCursorVisible();
    scheduleAutosave(this);
    this.requestRender();
  }

  // ---- Cursor & rendering -----------------------------------------------------

  /**
   * Place the cursor. Clears the selection and (by default) updates the
   * anchor column — typing-advance and Enter pass updateAnchor: false.
   */
  setCursor(row, col, { updateAnchor = true } = {}) {
    commitFloat(this); // placing the cursor confirms any move in progress
    let c = Math.max(0, col);
    if (this.viewMode === 'paged') c = Math.min(c, PAGE_COLS - 1);
    this.cursor = { row: Math.max(0, row), col: c };
    if (updateAnchor) this.anchorCol = this.cursor.col;
    this.selection = null;
    this.selAnchor = null;
    this.ensureCursorVisible();
    this.requestRender();
  }

  /** Auto-scroll the camera so the cursor stays in view (1-cell margin). */
  ensureCursorVisible() {
    const cam = this.camera;
    const vw = this.renderer.w / cam.zoom;
    const vh = this.renderer.h / cam.zoom;
    if (!vw || !vh) return;

    const x0 = colLeft(this.cursor.col);
    const y0 = rowTop(this.cursor.row);
    const x1 = x0 + CELL_W;
    const y1 = y0 + rowHeight(this.cursor.row);
    const mx = Math.min(CELL_W, Math.max(0, (vw - CELL_W) / 2));
    const my = Math.min(CELL_H, Math.max(0, (vh - CELL_H) / 2));

    if (x0 - mx < cam.x) cam.x = Math.max(-EDGE_PAD, x0 - mx);
    else if (x1 + mx > cam.x + vw) cam.x = x1 + mx - vw;
    if (y0 - my < cam.y) cam.y = Math.max(-EDGE_PAD, y0 - my);
    else if (y1 + my > cam.y + vh) cam.y = y1 + my - vh;
  }

  /** Coalesce redraws into one per animation frame. */
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.renderer.render();
      this.updateStatus();
    });
  }

  /** Call after any document edit: re-render, autosave, mark unsaved. */
  markChanged() {
    this.ants = null; // an edit dismisses the marching ants
    if (this.find) this.ui.refreshFind(); // matches may have moved
    this.setSaveState('unsaved');
    scheduleAutosave(this);
    this.requestRender();
  }

  /** Brief fading highlight over a cell rect (block drop, undo landing). */
  setFlash(rect, color) {
    this.flash = {
      rect,
      color: color || null,
      until: performance.now() + FLASH_MS,
      dur: FLASH_MS,
    };
    this.requestRender();
  }

  /** Transient status-bar message ("Copied 3R × 12C", refusals, ...). */
  flashStatus(msg) {
    this._statusMsg = msg;
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      this._statusMsg = null;
      this.updateStatus();
    }, STATUS_MSG_MS);
    this.updateStatus();
  }

  setPen(key, on) {
    this.pen[key] = on;
    this.requestRender(); // the cursor outline thickens with the pen
  }

  setSaveState(state) {
    this._saveState = state;
    this.updateStatus();
  }

  updateStatus() {
    const { row, col } = this.cursor;
    // Mid drag-select, the name box reads out the selection size.
    const sel = this.selection;
    setText(this.ui.pos, this.selectingDrag && sel
      ? `${sel.r1 - sel.r0 + 1}R × ${sel.c1 - sel.c0 + 1}C`
      : `R${row}C${col}`);

    // The contents strip shows what's in the cell under the cursor,
    // styled the way the cell is.
    const cell = this.doc.get(row, col);
    setText(this.ui.cellbox, cell ? cell.ch : '');
    const cb = this.ui.cellbox.style;
    cb.fontWeight = cell && cell.b ? '700' : '400';
    cb.fontStyle = cell && cell.i ? 'italic' : 'normal';
    cb.textDecoration = cell
      ? [cell.u && 'underline', cell.s && 'line-through']
        .filter(Boolean).join(' ') || 'none'
      : 'none';

    let mode = 'Ready';
    if (this.float) {
      mode = 'Select destination and press Enter, or press Esc to cancel';
    } else if (this._statusMsg) {
      mode = this._statusMsg;
    } else if (row % 2 !== 0) {
      mode = 'Midline';
    }
    setText(this.ui.mode, mode);

    setText(this.ui.zoomLevel, Math.round(this.camera.zoom * 100) + '%');
    const penText = [
      this.pen.b && 'Bold', this.pen.i && 'Italic',
      this.pen.u && 'Underline', this.pen.s && 'Strike',
    ].filter(Boolean).join(' · ');
    setText(this.ui.boldFlag, penText);
    setHidden(this.ui.boldFlag, !penText);
    // Style buttons tell the truth: with a selection they light up when
    // every cell in it carries the style (exactly when clicking would
    // remove it); otherwise they show the typing pen.
    let lit;
    if (sel) {
      const items = this.doc.cellsInRect(sel.r0, sel.r1, sel.c0, sel.c1);
      lit = (k) => items.length > 0 && items.every((v) => v[k]);
    } else {
      lit = (k) => this.pen[k];
    }
    for (const [k, btn] of Object.entries(this.ui.styleButtons)) {
      btn.setAttribute('aria-pressed', String(lit(k)));
    }
    const labels = {
      unsaved: 'Unsaved changes',
      autosaved: 'Saved to browser',
      saved: 'Saved to file',
      empty: 'New sheet',
    };
    setText(this.ui.saveState, labels[this._saveState] || labels.empty);
  }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}

function buildChrome(editor) {
  const $ = (id) => document.getElementById(id);
  const help = $('help');

  const ui = {
    pos: $('pos'),
    mode: $('mode'),
    cellbox: $('cell-preview'),
    zoomLevel: $('zoom-level'),
    boldFlag: $('bold-flag'),
    saveState: $('save-state'),
    isHelpOpen: () => !help.hidden,
    toggleHelp: () => { help.hidden = !help.hidden; },
    closeHelp: () => { help.hidden = true; },
  };

  // ---- Ribbon ----------------------------------------------------------

  const ribbonTabs = {
    home: $('tab-home'),
    insert: $('tab-insert'),
    file: $('tab-file'),
  };
  const ribbonPanes = {
    home: $('pane-home'),
    insert: $('pane-insert'),
    file: $('pane-file'),
  };
  const setRibbonTab = (name) => {
    for (const k of Object.keys(ribbonTabs)) {
      ribbonTabs[k].setAttribute('aria-selected', String(k === name));
      ribbonPanes[k].hidden = k !== name;
    }
  };
  for (const k of Object.keys(ribbonTabs)) {
    ribbonTabs[k].addEventListener('click', () => setRibbonTab(k));
  }

  // ---- Insert pane ---------------------------------------------------------

  $('btn-image').addEventListener('click', () => $('image-input').click());
  $('image-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) insertImage(editor, file, { ...editor.cursor });
    e.target.value = '';
    editor.canvas.focus();
  });

  /** Style a selection, or flip the typing pen — same as the chords. */
  const applyStyle = (key) => {
    if (editor.selection) toggleStyleSelection(editor, key);
    else editor.setPen(key, !editor.pen[key]);
  };

  ui.styleButtons = {
    b: $('rb-bold'),
    i: $('rb-italic'),
    u: $('rb-underline'),
    s: $('rb-strike'),
  };
  for (const [k, btn] of Object.entries(ui.styleButtons)) {
    btn.addEventListener('click', () => {
      applyStyle(k);
      editor.canvas.focus();
    });
  }
  $('rb-cut').addEventListener('click', () => {
    cutSelection(editor);
    editor.canvas.focus();
  });
  $('rb-copy').addEventListener('click', () => {
    copySelection(editor);
    editor.canvas.focus();
  });
  $('rb-paste').addEventListener('click', () => {
    paste(editor);
    editor.canvas.focus();
  });

  // ---- File pane ----------------------------------------------------------

  $('btn-new').addEventListener('click', () => {
    newDocument(editor);
    editor.canvas.focus();
  });
  $('btn-open').addEventListener('click', () => {
    commitFloat(editor);
    openFilePicker();
  });
  $('btn-save').addEventListener('click', () => {
    commitFloat(editor);
    saveToFile(editor);
    editor.canvas.focus();
  });
  $('btn-export').addEventListener('click', () => {
    commitFloat(editor);
    exportText(editor);
    editor.canvas.focus();
  });

  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) openFile(editor, file);
    e.target.value = '';
    editor.canvas.focus();
  });

  // ---- Zoom ------------------------------------------------------------

  const keyZoom = (delta) => {
    const sx = editor.renderer.w / 2;
    const sy = editor.renderer.h / 2;
    editor.camera.setZoom(editor.camera.zoom + delta, sx, sy);
    scheduleAutosave(editor);
    editor.requestRender();
    editor.canvas.focus();
  };
  $('btn-zoom-in').addEventListener('click', () => keyZoom(ZOOM_KEY_STEP));
  $('btn-zoom-out').addEventListener('click', () => keyZoom(-ZOOM_KEY_STEP));
  $('btn-zoom-reset').addEventListener('click', () =>
    keyZoom(1 - editor.camera.zoom));

  // ---- Help --------------------------------------------------------------

  $('btn-help').addEventListener('click', () => ui.toggleHelp());
  $('btn-help-close').addEventListener('click', () => {
    ui.closeHelp();
    editor.canvas.focus();
  });
  help.addEventListener('click', (e) => {
    if (e.target === help) ui.closeHelp(); // click the scrim to dismiss
  });

  // Edits to the filename only affect future saves; just refocus politely.
  $('filename').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
      editor.canvas.focus();
    }
  });

  // ---- Find ----------------------------------------------------------------

  const findBar = $('find-bar');
  const findInput = $('find-input');
  const findCount = $('find-count');
  const findToggles = {
    matchCase: $('find-case'),
    wholeWord: $('find-word'),
    highlightAll: $('find-all'),
  };
  let lastQuery = '';

  function updateFindUI() {
    const f = editor.find;
    if (!f) return;
    setText(findCount,
      f.query === '' ? ''
        : f.matches.length ? `${f.index + 1} of ${f.matches.length}`
          : 'No matches');
    for (const [k, btn] of Object.entries(findToggles)) {
      btn.setAttribute('aria-pressed', f[k] ? 'true' : 'false');
    }
  }

  /** Pan the camera so a match rect is in view (cursor stays put). */
  function revealMatch(m) {
    const cam = editor.camera;
    const vw = editor.renderer.w / cam.zoom;
    const vh = editor.renderer.h / cam.zoom;
    if (!vw || !vh) return;
    const x0 = colLeft(m.c0);
    const x1 = colLeft(m.c1 + 1);
    const y0 = rowTop(m.r);
    const y1 = y0 + rowHeight(m.r);
    const mx = Math.min(CELL_W * 2, Math.max(0, (vw - (x1 - x0)) / 2));
    const my = Math.min(CELL_H * 2, Math.max(0, (vh - (y1 - y0)) / 2));
    if (x0 - mx < cam.x) cam.x = Math.max(-EDGE_PAD, x0 - mx);
    else if (x1 + mx > cam.x + vw) cam.x = x1 + mx - vw;
    if (y0 - my < cam.y) cam.y = Math.max(-EDGE_PAD, y0 - my);
    else if (y1 + my > cam.y + vh) cam.y = y1 + my - vh;
  }

  function runFind(navigate) {
    const f = editor.find;
    if (!f) return;
    f.matches = findMatches(editor.doc, f.query, f);
    if (!f.matches.length) {
      f.index = -1;
    } else {
      // Start from the match at/after the cursor.
      const { row, col } = editor.cursor;
      const at = f.matches.findIndex(
        (m) => m.r > row || (m.r === row && m.c1 >= col));
      f.index = at === -1 ? 0 : at;
      if (navigate) revealMatch(f.matches[f.index]);
    }
    updateFindUI();
    editor.requestRender();
  }

  function stepFind(dir) {
    const f = editor.find;
    if (!f || !f.matches.length) return;
    f.index = (f.index + dir + f.matches.length) % f.matches.length;
    const m = f.matches[f.index];
    editor.setCursor(m.r, m.c0); // the found cell becomes the active one
    updateFindUI();
  }

  ui.openFind = () => {
    if (!editor.find) {
      editor.find = {
        query: lastQuery,
        matchCase: false,
        wholeWord: false,
        highlightAll: true,
        matches: [],
        index: -1,
      };
    }
    findBar.hidden = false;
    findInput.value = editor.find.query;
    findInput.focus();
    findInput.select();
    runFind(true);
  };

  ui.closeFind = () => {
    if (!editor.find) return false;
    lastQuery = editor.find.query;
    editor.find = null;
    findBar.hidden = true;
    editor.canvas.focus();
    editor.requestRender();
    return true;
  };

  ui.refreshFind = () => runFind(false);

  findInput.addEventListener('input', () => {
    if (!editor.find) return;
    editor.find.query = findInput.value;
    runFind(true);
  });
  findInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      ui.closeFind();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      findInput.select();
    }
  });
  $('find-prev').addEventListener('click', () => {
    stepFind(-1);
    findInput.focus();
  });
  $('find-next').addEventListener('click', () => {
    stepFind(1);
    findInput.focus();
  });
  $('find-close').addEventListener('click', () => ui.closeFind());
  for (const [k, btn] of Object.entries(findToggles)) {
    btn.addEventListener('click', () => {
      const f = editor.find;
      if (!f) return;
      f[k] = !f[k];
      runFind(k !== 'highlightAll');
      findInput.focus();
    });
  }

  // ---- Sheet tabs ---------------------------------------------------------

  const tabsWrap = $('sheet-tabs');

  function startRename(label, i) {
    const input = document.createElement('input');
    input.className = 'tab-rename';
    input.maxLength = 31;
    input.value = editor.sheets[i].name;
    label.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = editor.sheets[i].name;
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      editor.renameSheet(i, input.value);
      editor.canvas.focus();
    });
  }

  ui.renderTabs = () => {
    tabsWrap.textContent = '';
    editor.sheets.forEach((s, i) => {
      const tab = document.createElement('div');
      tab.className =
        'sheet-tab' + (i === editor.sheetIndex ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = s.name;
      label.title = 'Double-click to rename';
      tab.appendChild(label);
      if (editor.sheets.length > 1) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'tab-close';
        close.textContent = '×';
        close.title = 'Delete sheet';
        close.setAttribute('aria-label', `Delete ${s.name}`);
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          editor.deleteSheet(i);
        });
        tab.appendChild(close);
      }
      tab.addEventListener('click', () => {
        editor.activateSheet(i);
        editor.canvas.focus();
      });
      tab.addEventListener('dblclick', () => startRename(label, i));
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          editor.deleteSheet(i);
        }
      });
      tabsWrap.appendChild(tab);
    });
  };

  $('btn-add-sheet').addEventListener('click', () => {
    editor.addSheet();
    editor.canvas.focus();
  });

  // ---- Context menu ------------------------------------------------------

  const menu = $('ctx-menu');
  ui.hideContextMenu = () => { menu.hidden = true; };
  ui.showContextMenu = (x, y) => {
    menu.hidden = false;
    menu.style.left =
      Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) +
      'px';
    menu.style.top =
      Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)) +
      'px';
  };
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    ui.hideContextMenu();
    editor.canvas.focus();
    switch (btn.dataset.act) {
      case 'cut': cutSelection(editor); break;
      case 'copy': copySelection(editor); break;
      case 'paste': paste(editor); break;
      case 'bold': applyStyle('b'); break;
      case 'italic': applyStyle('i'); break;
      case 'underline': applyStyle('u'); break;
      case 'strike': applyStyle('s'); break;
      case 'clear':
        clearSelection(editor);
        editor.setCursor(editor.cursor.row, editor.cursor.col);
        break;
      case 'deselect':
        editor.setCursor(editor.cursor.row, editor.cursor.col);
        break;
      default: break;
    }
  });
  window.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) ui.hideContextMenu();
  }, true);

  // ---- View mode & printing -------------------------------------------------

  const viewBtns = {
    infinite: $('view-infinite'),
    paged: $('view-paged'),
  };

  ui.updateViewButtons = () => {
    viewBtns.infinite.setAttribute(
      'aria-pressed', String(editor.viewMode === 'infinite'));
    viewBtns.paged.setAttribute(
      'aria-pressed', String(editor.viewMode === 'paged'));
  };

  /** Enter paged view, wrapping overflow first (one undo step). */
  function wrapAndSwitch(alreadyConfirmed) {
    if (editor.viewMode === 'paged') return true;
    commitFloat(editor);
    if (docOverflowsWidth(editor.doc, PAGE_COLS)) {
      if (!alreadyConfirmed && !confirm(
        'Some content is wider than a page. Switching to pages will ' +
        'wrap it onto the rows below.\n\nContinue? (One undo step puts ' +
        'it back.)')) {
        return false;
      }
      const before = {
        row: editor.cursor.row,
        col: editor.cursor.col,
        anchor: editor.anchorCol,
      };
      if (rewrapDoc(editor.doc, PAGE_COLS)) {
        editor.doc.commit({ before, after: before });
        editor.markChanged();
      }
    }
    editor.setViewMode('paged');
    return true;
  }

  viewBtns.paged.addEventListener('click', () => {
    wrapAndSwitch(false);
    editor.canvas.focus();
  });
  viewBtns.infinite.addEventListener('click', () => {
    editor.setViewMode('infinite');
    editor.canvas.focus();
  });

  ui.requestPrint = () => {
    commitFloat(editor); // a floating block must land before it prints
    if (editor.viewMode === 'infinite' &&
        docOverflowsWidth(editor.doc, PAGE_COLS) &&
        confirm(
          'The sheet is wider than one page.\nSwitch to paged view ' +
          '(content will wrap) so you can check the layout first?\n\n' +
          'Cancel prints page-width slices as they are.')) {
      wrapAndSwitch(true);
    }
    window.print();
  };

  const printPages = $('print-pages');
  window.addEventListener('beforeprint', () =>
    buildPrintPages(editor, printPages));
  window.addEventListener('afterprint', () => {
    printPages.textContent = '';
  });

  // ---- Spelling -----------------------------------------------------------

  const SPELL_KEY = 'grid-editor.spelling.v1';
  const spellBtn = $('btn-spell');
  async function setSpelling(on, persist = true) {
    const sp = editor.spell;
    sp.on = on;
    if (on && !sp.dict) {
      spellBtn.textContent = 'Spelling…';
      try {
        sp.dict = await loadDict();
      } catch {
        sp.on = false;
        editor.flashStatus('The spelling dictionary is unavailable');
      }
    }
    sp.ready = sp.on && !!sp.dict;
    spellBtn.textContent = 'Spelling';
    spellBtn.setAttribute('aria-pressed', String(sp.on));
    if (persist) {
      try {
        localStorage.setItem(SPELL_KEY, sp.on ? '1' : '0');
      } catch { /* unavailable */ }
    }
    editor.requestRender();
  }
  spellBtn.addEventListener('click', () => {
    setSpelling(!editor.spell.on);
    editor.canvas.focus();
  });
  try {
    if (localStorage.getItem(SPELL_KEY) === '1') setSpelling(true, false);
  } catch { /* unavailable */ }

  // ---- Drag & drop a .grid file -------------------------------------------

  const dropScrim = $('drop-scrim');
  const dropTitle = $('drop-title');
  const dropSub = $('drop-sub');
  let dragDepth = 0;
  const hasFiles = (e) =>
    e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  // Mid-drag the file's bytes are off limits but its MIME type isn't —
  // enough to tell a picture (placed at the pointer, so the scrim must
  // stay out of the way) from a .grid file (opened, position-free).
  const isImageDrag = (e) => {
    const items = e.dataTransfer && e.dataTransfer.items;
    if (!items) return false;
    return Array.from(items).some(
      (it) => it.kind === 'file' && it.type.startsWith('image/'));
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    const img = isImageDrag(e);
    dropScrim.classList.toggle('drop-image', img);
    setText(dropTitle, img ? 'Drop to insert picture' : 'Drop to open');
    setText(dropSub, img ? 'it lands where you drop it' : '.grid files');
    dropScrim.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropScrim.hidden = true;
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropScrim.hidden = true;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (file.type.startsWith('image/')) {
      // A picture lands where it was dropped.
      const rect = editor.canvas.getBoundingClientRect();
      const cam = editor.camera;
      insertImage(editor, file, {
        row: rowAtY(Math.max(0, cam.toWorldY(e.clientY - rect.top))),
        col: colAtX(cam.toWorldX(e.clientX - rect.left)),
      });
      return;
    }
    if (/\.(grid|json)$/i.test(file.name)) openFile(editor, file);
    else {
      editor.flashStatus(
        `Can't open ${file.name} — .grid files and images only`);
    }
  });

  return ui;
}

// ---- Boot -------------------------------------------------------------------

const canvas = document.getElementById('grid');
const editor = new Editor(canvas);

installKeyboard(editor);
installMouse(editor);
initHelp();

const onResize = () => editor.renderer.resize();
window.addEventListener('resize', onResize);
if (window.ResizeObserver) {
  new ResizeObserver(onResize).observe(canvas.parentElement);
}

// Re-render crisply when the window moves to a display with a different
// pixel density (a plain resize listener misses that).
function watchDPR() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    .addEventListener('change', () => {
      editor.renderer.resize();
      watchDPR();
    }, { once: true });
}
watchDPR();

// Ask the browser not to evict our storage (autosave + picture bytes).
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

// Don't lose the last half-second of edits when the tab goes away: flush
// any debounced autosave on pagehide / when the page is backgrounded.
window.addEventListener('pagehide', flushAutosave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAutosave();
});

editor.renderer.resize();
if (!loadAutosave(editor)) editor.setSaveState('empty');
editor.requestRender();
canvas.focus();
