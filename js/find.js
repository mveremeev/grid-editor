// find.js — text search over the grid. A match is a horizontal run of
// cells on one row whose characters equal the query. Empty cells between
// stored characters read as spaces, so "my cat" finds the phrase even
// though the gap cell was never typed.

/**
 * All matches of `query` as { r, c0, c1 } rects, sorted by row then
 * column. Options: matchCase, wholeWord.
 */
export function findMatches(doc, query, opts = {}) {
  if (!query) return [];
  const q = opts.matchCase ? query : query.toLowerCase();
  const isWordCh = (v) => !!(v && /[A-Za-z0-9_']/.test(v.ch));
  const out = [];
  for (const [r, row] of doc.rows) {
    const ext = doc.rowExtent(r);
    if (!ext || ext.c1 - ext.c0 + 1 < q.length) continue;
    let s = '';
    for (let c = ext.c0; c <= ext.c1; c++) {
      const v = row.get(c);
      s += v ? v.ch : ' ';
    }
    if (!opts.matchCase) s = s.toLowerCase();
    let i = 0;
    while ((i = s.indexOf(q, i)) !== -1) {
      const c0 = ext.c0 + i;
      const c1 = c0 + q.length - 1;
      if (!opts.wholeWord ||
          (!isWordCh(row.get(c0 - 1)) && !isWordCh(row.get(c1 + 1)))) {
        out.push({ r, c0, c1 });
      }
      i += 1;
    }
  }
  out.sort((a, b) => a.r - b.r || a.c0 - b.c0);
  return out;
}
