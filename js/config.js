// config.js — shared constants for geometry, type, and theme.
// All sizes are "world pixels" at zoom = 1.

// One cell = one character. Cells are taller than wide (~1 : 1.8).
export const CELL_W = 14;
export const CELL_H = 25;

// Midline (odd) rows render thin, so character rows sit visually adjacent
// and midline content reads as centred in the seam.
export const MID_H = 11;

// One even row + one odd row = one vertical period of the grid.
export const PAIR_H = CELL_H + MID_H;

// Glyph size at zoom 1 (centred in the cell; advance width is irrelevant
// because every glyph is drawn per-cell).
export const FONT_SIZE = 19;

// Monospace only — non-negotiable. One well-chosen mono stack is the
// entire type system.
export const FONT_STACK =
  'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", ' +
  '"Fira Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';

// Tab jumps to the next multiple of TAB_W columns. No tab character is
// ever stored — in a grid, spacing is just empty cells.
export const TAB_W = 4;

// The sheet never touches the window edge: panning is allowed this far
// past the origin, so the top-left corner sits in from the chrome.
export const EDGE_PAD = 36;

// Paged view: an A4-portrait-shaped page in cells. 70 columns ≈ 2.6mm
// per character across a 180mm printable width; 40 row pairs fill the
// height. Pages are separated by a gap on the canvas.
export const PAGE_COLS = 70;
export const PAGE_ROW_SPAN = 80; // row indices per page (40 pairs)
export const PAGE_GAP = 24;      // world px between pages on the canvas

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_WHEEL_RATE = 0.0022; // wheel-delta → zoom factor exponent
export const ZOOM_KEY_STEP = 0.1;      // Ctrl/Cmd +/- zoom delta
export const ZOOM_SNAP = 0.015;        // snap-to-100% capture zone

// Theme: engineering quad paper. Bluish-white sheet, faded blueprint
// rules, ink glyphs, one Excel-green accent for the cursor/redline.
export const COLORS = {
  paper:      '#f7fafc',
  midTint:    'rgba(98, 132, 163, 0.06)',
  gridLine:   'rgba(98, 132, 163, 0.20)',
  gridStrong: '#5b7e9e',                  // origin rules at row 0 / col 0
  ink:        '#1c2733',
  inkFaint:   'rgba(28, 39, 51, 0.55)',   // far-zoom "ink mark" rectangles
  accent:     '#217346',                  // Microsoft Excel green
  selFill:    'rgba(33, 115, 70, 0.12)',
  squiggle:   '#c8281e',                  // spellcheck underline
  findFill:   'rgba(255, 196, 8, 0.38)',  // find: every match
  findEdge:   '#b8860b',                  // find: the current match
  desk:       '#e2e0dd',                  // paged view: behind the pages
  pageEdge:   '#b6c1cb',                  // paged view: page outline
};
