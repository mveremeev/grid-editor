# Grid Editor

A character-grid text editor: **Excel, but every cell holds one character and
you type into it.** Position is absolute — a character lives at `(row, col)`
and stays there. Typing overwrites the cell under the cursor and advances
right; nothing ever shifts. Built for notes where spatial layout matters:
matrices, aligned equations, diagrams.

Vanilla web (no framework, no editor library, no build step): one HTML page,
one stylesheet, and ES modules drawing to a single `<canvas>`.

## Running it (Linux / macOS)

ES modules won't load from `file://`, so the page needs to be served over
HTTP. Any static server works. From this directory:

**With npm (recommended):**

```sh
npm install
npm start
```

Then open <http://localhost:3000>.

**Without installing anything** (pick whichever you have):

```sh
npx serve .                      # Node ≥ 14
# or
python3 -m http.server 8000      # then open http://localhost:8000
```

Requirements: a current browser, and Node ≥ 14 *or* Python 3 — both ship with
or are a package-manager install away on any Linux distro and macOS.

## Using it

Press **F1** in the app for the full key reference. The short version:

| Action | How |
| --- | --- |
| Write | Type — fills the cell, moves right, never shifts neighbours |
| New row | `Enter` drops a row and returns to the column typing started |
| Move | Arrows (vertical moves cell-to-cell); click anywhere to place the cursor |
| Midlines | `Alt`+`↑/↓` steps a single row, onto the thin seam row between character rows — put a centred `=` there |
| Erase | `Backspace` (left + clear), `Delete` (clear here) |
| Tab stops | `Tab` / `Shift`+`Tab` jump 4 columns (no tab character is ever stored) |
| Select | Drag, or `Shift`+arrows — selections are always rectangles; double-click grabs a word, triple-click the row |
| Jump | `Ctrl/⌘`+arrows leap to the edges of the content, Excel-style |
| Find | `Ctrl/⌘`+`F` — match case / whole words / highlight-all toggles; gaps between characters read as spaces |
| Move a block | With a selection, arrows float the block over the sheet (`Alt` for single-row steps), or hold `Alt`/`Option` and drag it with the mouse; `Ctrl/⌘`+drag drags a *copy*. `Enter` drops it, `Esc` or right-click sends it home — nothing underneath is touched until the drop |
| Blocks | `Ctrl/⌘`+`C` / `X` / `V` copy, cut, paste rectangles — paste arrives as a floating preview you place before it commits |
| Sheets | Tabs at the bottom: `+` adds one, double-click renames, `×` deletes |
| Pages | The default view: A4 pages, typing wraps at the margin. The status-bar toggle switches to an infinite canvas; switching back warns before wrapping anything too wide (one undo puts it back) |
| Print | `Ctrl/⌘`+`P` — prints the pages exactly as shown (paged view), or page-width slices from the infinite canvas after a warning |
| Spelling | Toggle in the status bar — red squiggles on character rows, no grammar nonsense |
| Pictures | Insert tab, paste, or drop an image — the frame snaps to cells (drag to move, corners to resize, `Delete` removes); bytes live in the browser and embed into `.grid` files |
| Styles | `Ctrl/⌘`+`B`/`I`/`U` bold/italic/underline, `Ctrl/⌘`+`5` strikethrough — style pens for new typing, or restyle the selection |
| Undo / redo | `Ctrl/⌘`+`Z` / `Ctrl/⌘`+`Shift`+`Z` |
| Pan / zoom | Wheel scrolls, `Shift`+wheel goes sideways, middle-drag pans, `Ctrl/⌘`+wheel or `Ctrl/⌘`+`+/−/0` zooms |
| Save / open | `Ctrl/⌘`+`S` downloads a `.grid` file; `Ctrl/⌘`+`O` opens one |
| Export | "Export .txt" in the toolbar — a one-way, lossy plain-text snapshot |

Work autosaves to the browser's local storage as you go (close the tab,
reopen, it's there). `.grid` files are the portable form — gzip-compressed
JSON holding every sheet's sparse cell map, cursor, and camera (`gunzip`
one to inspect it); plain text is deliberately *not* the canonical format.

**Midlines, briefly:** even-numbered rows hold characters; odd-numbered rows
are thin "midline" rows drawn in the seam between them. An even-height matrix
has no centre row — the midline manufactures one, so a centred `=` between
two matrix rows is a real, storable character at a real integer row.

## Project layout

```
index.html          shell: ribbon (File/Home), canvas, status bar, F1 help
css/style.css       chrome styling (spreadsheet-style bars around the paper)
js/config.js        geometry constants (1:1.8 cell aspect), zoom limits, theme
js/camera.js        parity row math + camera (pan/zoom, origin clamping)
js/doc.js           the document: sparse cell map + undo/redo diff stack
js/selection.js     rectangular selections; nudge / copy / cut / paste / bold
js/renderer.js      canvas viewport: culling, gridlines, cursor, glyphs
js/keyboard.js      all key bindings
js/help.js          F1 reference card, rendered per-OS (macOS/Windows/Linux)
js/mouse.js         click/drag/wheel/middle-drag
js/find.js          text search (Ctrl/⌘+F) over rows
js/images.js        embedded pictures: IndexedDB bytes, cell-snapped frames
js/pages.js         A4 page geometry, rewrap-to-width, print rendering
js/persistence.js   autosave, .grid save/open (workbook v2), .txt export
js/spell.js         spelling dictionary (loaded on demand)
js/main.js          Editor state + sheets, chrome wiring, boot
words.txt           the spellcheck wordlist (fetched when toggled on)
test/run.mjs        headless logic tests (npm test, needs only Node)
```

## Design decisions carried through (from the plan)

- Sparse `Map` of cells — empty cells aren't stored, which is what makes the
  infinite canvas cheap.
- The canvas is the *viewport*: only the visible coordinate range is drawn
  each frame (with a hybrid that iterates the map instead when the map is
  smaller than the view).
- Hard top-left origin: panning, the cursor, writes, and block nudges are all
  clamped — no negative rows or columns. The origin edges render as heavier
  rules.
- Overwrite-only typing; the selected cell *is* the cursor; Enter returns to
  the anchor column so matrix rows stack aligned.
- Bold is free (monospace bold is still one cell per glyph); zoom is bound to
  modifier+wheel and keys and zooms toward the pointer/cursor.

## Deferred (per the plan's open questions)

Heading rows, multiple documents/tabs, and tuned export formatting are left
open. Tab distance currently snaps to the next multiple of 4 (`TAB_W` in
`js/config.js`); the cell aspect and zoom bounds live there too — tune by feel.
