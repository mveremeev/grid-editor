// spell.js — the spelling dictionary. words.txt (one lowercase word per
// line) is fetched on demand the first time checking is switched on, so
// the editor pays nothing for it until then. No grammar checking — this
// is a grid, half of what's on it isn't sentences.

let promise = null;

/** Load (once) and cache the dictionary as a Set. */
export function loadDict() {
  if (!promise) {
    promise = fetch('words.txt')
      .then((r) => {
        if (!r.ok) throw new Error('wordlist missing');
        return r.text();
      })
      .then((text) => new Set(text.split('\n')));
  }
  return promise;
}

/**
 * True when a word (lowercased) should be marked. Single letters pass,
 * possessives check their stem, surrounding apostrophes are trimmed.
 */
export function misspelled(dict, word) {
  const w = word.replace(/^'+|'+$/g, '');
  if (w.length < 2) return false;
  if (dict.has(w)) return false;
  if (w.endsWith("'s") && dict.has(w.slice(0, -2))) return false;
  return true;
}
