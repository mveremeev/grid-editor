// help.js — the F1 reference card. The shortcut list is data, rendered
// for whichever platform is selected (macOS / Windows / Linux). The
// detected platform is the default tab; the choice is remembered.

const LS_KEY = 'grid-editor.help-platform.v1';

export function detectPlatform() {
  const p = (
    (navigator.userAgentData && navigator.userAgentData.platform) ||
    navigator.platform || ''
  ).toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'win';
  return 'linux';
}

// '$name' tokens resolve per platform; macOS gets the symbol glyphs and
// no '+' separators, Windows/Linux get spelled-out keys joined with '+'.
const TOKENS = {
  mod:    { mac: '⌘', other: 'Ctrl' },
  alt:    { mac: '⌥', other: 'Alt' },
  shift:  { mac: '⇧', other: 'Shift' },
  enter:  { mac: 'Return', other: 'Enter' },
  bksp:   { mac: '⌫', other: 'Backspace' },
  arrows: { mac: '←↑↓→', other: '←↑↓→' },
};

// An item is { label, combos, altSep?, text? }.
//  combos: array of key-combos (each an array of tokens), or a
//          { mac, win, linux, other } map of such arrays.
//  '~word' tokens render as plain action text (wheel, drag) — not keys.
//  text:   action-only row with no keys at all.
const SECTIONS = [
  {
    title: 'Write',
    items: [
      { label: 'Fill the cell, move right', text: 'type any character' },
      { label: 'Erase the cell, move right', combos: [['Space']] },
      { label: 'New row, back at the start column', combos: [['$enter']] },
      { label: 'Previous row, same column', combos: [['$shift', '$enter']] },
      { label: 'Erase left', combos: [['$bksp']] },
      { label: 'Erase under the cursor',
        combos: { mac: [['Fn', '$bksp']], other: [['Delete']] } },
      { label: 'Erase the word to the left',
        combos: { mac: [['$alt', '$bksp']], other: [['$mod', '$bksp']] } },
      { label: 'Erase to the row start',
        combos: { mac: [['$mod', '$bksp']],
                  other: [['$mod', '$shift', '$bksp']] } },
      { label: 'Next / previous tab stop',
        combos: [['Tab'], ['$shift', 'Tab']] },
      { label: 'Bold / italic / underline',
        combos: [['$mod', 'B'], ['$mod', 'I'], ['$mod', 'U']] },
      { label: 'Strikethrough', combos: [['$mod', '5']] },
    ],
  },
  {
    title: 'Move',
    note: 'Clicking places the cursor anywhere. On macOS, ⌥+←/→ also ' +
      'leaps along the row.',
    items: [
      { label: 'One cell (vertical skips midlines)',
        combos: [['←'], ['↑'], ['↓'], ['→']], altSep: '' },
      { label: 'A single row — onto the midline',
        combos: [['$alt', '↑'], ['$alt', '↓']] },
      { label: 'Leap to the edge of the content',
        combos: [['$mod', '$arrows']] },
      { label: 'Row start / past the last character',
        combos: [['Home'], ['End']] },
      { label: 'Top-left / last cell of the content',
        combos: [['$mod', 'Home'], ['$mod', 'End']] },
      { label: 'A screenful up / down', combos: [['PgUp'], ['PgDn']] },
      { label: 'Find — next / previous match',
        combos: [['$mod', 'F'], ['$enter'], ['$shift', '$enter']] },
    ],
  },
  {
    title: 'Select',
    note: 'Selections are rectangles. While you drag one out, the name ' +
      'box reads its size (3R × 12C).',
    items: [
      { label: 'Select with the mouse', text: 'drag across cells' },
      { label: 'Grow a selection',
        combos: [['$shift', '$arrows'], ['$shift', '~click']] },
      { label: 'Stretch it to the content edge',
        combos: [['$mod', '$shift', '$arrows']] },
      { label: 'Select the word / the whole row',
        text: 'double / triple-click' },
      { label: 'Select everything', combos: [['$mod', 'A']] },
      { label: 'Deselect', combos: [['Esc']] },
    ],
  },
  {
    title: 'Blocks & clipboard',
    note: 'Moved and pasted blocks float over the sheet — nothing ' +
      'underneath changes until you drop them. Typing or clicking ' +
      'elsewhere drops too.',
    items: [
      { label: 'Pick up & move the block',
        combos: [['$arrows'], ['$alt', '~drag']] },
      { label: 'Drag a copy of the block', combos: [['$mod', '~drag']] },
      { label: 'Move it a single row', combos: [['$alt', '$arrows']] },
      { label: 'Drop the block here', combos: [['$enter']] },
      { label: 'Cancel — send it home',
        combos: [['Esc'], ['~right-click']] },
      { label: 'Copy / cut the block',
        combos: [['$mod', 'C'], ['$mod', 'X']] },
      { label: 'Paste — as a floating preview', combos: [['$mod', 'V']] },
      { label: 'Dismiss the marching ants', combos: [['Esc']] },
      { label: 'Undo', combos: [['$mod', 'Z']] },
      { label: 'Redo',
        combos: { mac: [['$shift', '$mod', 'Z']],
                  win: [['$mod', 'Y'], ['$mod', '$shift', 'Z']],
                  linux: [['$mod', '$shift', 'Z'], ['$mod', 'Y']] } },
    ],
  },
  {
    title: 'Mouse & view',
    note: 'A drag-selection held past the window edge keeps scrolling ' +
      'on its own.',
    items: [
      { label: 'Scroll / scroll sideways',
        combos: [['~wheel'], ['$shift', '~wheel']] },
      { label: 'Pan freely', combos: [['~middle-drag']] },
      { label: 'Zoom at the pointer', combos: [['$mod', '~wheel']] },
      { label: 'Zoom in / out', combos: [['$mod', '+'], ['$mod', '−']] },
      { label: 'Reset zoom — it also snaps near 100%',
        combos: [['$mod', '0']] },
      { label: 'Cut / copy / paste menu', combos: [['~right-click']] },
    ],
  },
  {
    title: 'Sheets & file',
    note: 'Sheet tabs live along the bottom of the window.',
    items: [
      { label: 'Add a sheet', text: '+ on the tab bar' },
      { label: 'Rename a sheet', text: 'double-click its tab' },
      { label: 'Delete a sheet', text: '× or middle-click its tab' },
      { label: 'Save a .grid file (all sheets)', combos: [['$mod', 'S']] },
      { label: 'Open a file',
        combos: [['$mod', 'O'], ['~drop it anywhere']] },
      { label: 'Insert a picture', text: 'Insert tab · paste · drop' },
      { label: 'Move / resize / delete a picture',
        text: 'drag · corners · Delete' },
      { label: 'Export .txt — the selection, if any', text: 'toolbar' },
      { label: 'Infinite canvas / A4 pages', text: 'status-bar toggle' },
      { label: 'Print — exactly the pages shown', combos: [['$mod', 'P']] },
      { label: 'Check spelling', text: 'status-bar toggle' },
      { label: 'This reference', combos: [['F1']] },
    ],
  },
];

// Two balanced columns of sections.
const COLUMNS = [[0, 1, 2], [3, 4, 5]];

function keyLabel(token, platform) {
  if (token[0] !== '$') return token;
  const t = TOKENS[token.slice(1)];
  return t[platform] || t.other;
}

function comboHTML(combo, platform) {
  const parts = [];
  combo.forEach((token, i) => {
    if (i > 0 && platform !== 'mac') {
      parts.push('<span class="key-sep">+</span>');
    }
    if (token[0] === '~') {
      parts.push(`<span class="key-act">${token.slice(1)}</span>`);
    } else {
      parts.push(`<kbd>${keyLabel(token, platform)}</kbd>`);
    }
  });
  return parts.join('');
}

function itemHTML(item, platform) {
  let keys;
  if (item.text) {
    keys = `<span class="key-act">${item.text}</span>`;
  } else {
    let combos = item.combos;
    if (!Array.isArray(combos)) {
      combos = combos[platform] || combos.other || [];
    }
    const sep = item.altSep === ''
      ? ''
      : '<span class="key-alt">/</span>';
    keys = combos.map(c => comboHTML(c, platform)).join(sep);
  }
  return (
    '<div class="help-row">' +
    `<span class="help-label">${item.label}</span>` +
    `<span class="help-keys">${keys}</span>` +
    '</div>'
  );
}

function sectionHTML(section, platform) {
  return (
    '<section class="help-section">' +
    `<h3>${section.title}</h3>` +
    (section.note ? `<p class="help-note">${section.note}</p>` : '') +
    section.items.map(it => itemHTML(it, platform)).join('') +
    '</section>'
  );
}

function bodyHTML(platform) {
  return COLUMNS.map(col =>
    '<div class="help-col">' +
    col.map(i => sectionHTML(SECTIONS[i], platform)).join('') +
    '</div>'
  ).join('');
}

export function initHelp() {
  const body = document.getElementById('help-body');
  const tabs = Array.from(
    document.querySelectorAll('#help-tabs button[data-platform]'),
  );

  let platform = null;
  try {
    platform = localStorage.getItem(LS_KEY);
  } catch { /* unavailable */ }
  if (!['mac', 'win', 'linux'].includes(platform)) {
    platform = detectPlatform();
  }

  const render = () => {
    body.innerHTML = bodyHTML(platform);
    for (const tab of tabs) {
      tab.setAttribute(
        'aria-selected',
        tab.dataset.platform === platform ? 'true' : 'false',
      );
    }
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      platform = tab.dataset.platform;
      try {
        localStorage.setItem(LS_KEY, platform);
      } catch { /* unavailable */ }
      render();
    });
  }

  render();
}
