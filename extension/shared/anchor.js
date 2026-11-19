// Finds a quote from Claude inside a page's text layer.
// The page is given as text segments (the text nodes of pdf.js's text layer, in order).
// Matching ignores whitespace, case, ligatures, curly quotes, dash variants and
// line-break hyphenation, then maps the hit back to (segment, offset) pairs.

const PREFIX_CHARS = 40; // about the first 8 words

function foldChar(c) {
  let s = c.normalize('NFKC').toLowerCase();
  s = s.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');
  s = s.replace(/[‐-―−]/g, '-');
  return s;
}

const isSpace = (c) => /\s/.test(c);
const isLetter = (c) => !!c && /\p{L}/u.test(c);

// Returns the folded text without whitespace and, per folded char, its index in the input.
export function normalize(input) {
  let norm = '';
  const map = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (isSpace(c)) continue;
    if (c === '-' || c === '­') {
      // Hyphen at a line break between letters: drop it ("retrie-\nval" -> "retrieval").
      let j = i + 1;
      while (j < input.length && isSpace(input[j])) j++;
      if (j > i + 1 && isLetter(input[i - 1]) && isLetter(input[j])) continue;
      if (c === '­') continue;
    }
    for (const f of foldChar(c)) {
      if (isSpace(f)) continue;
      norm += f;
      map.push(i);
    }
  }
  return { norm, map };
}

function locate(segs, startIdx, endIdx) {
  // startIdx/endIdx are indices into segs.join(' '); endIdx is exclusive.
  let base = 0;
  const pos = (idx, isEnd) => {
    base = 0;
    for (let s = 0; s < segs.length; s++) {
      const len = segs[s].length;
      if (idx < base + len || (isEnd && idx <= base + len)) return [s, idx - base];
      base += len + 1;
    }
    return [segs.length - 1, segs.at(-1).length];
  };
  const [startSeg, startOff] = pos(startIdx, false);
  const [endSeg, endOff] = pos(endIdx, true);
  return { startSeg, startOff, endSeg, endOff };
}

export function findQuote(segs, quote) {
  const joined = segs.join(' ');
  const hay = normalize(joined);
  const needle = normalize(quote).norm.replace(/^["']+|["']+$/g, '');
  if (!needle || !hay.norm) return null;

  const hit = (at, len, method) => {
    const startIdx = hay.map[at];
    const endIdx = hay.map[Math.min(at + len, hay.map.length) - 1] + 1;
    return { ...locate(segs, startIdx, endIdx), method };
  };

  // Curly quotes around a quote are usually in the PDF too, so try with them first.
  const full = normalize(quote).norm;
  let at = hay.norm.indexOf(full);
  if (at >= 0) return hit(at, full.length, 'exact');
  at = hay.norm.indexOf(needle);
  if (at >= 0) {
    // Widen to surrounding quote marks if the page has them.
    let s = at, e = at + needle.length;
    if (/["']/.test(hay.norm[s - 1] || '')) s--;
    if (/["']/.test(hay.norm[e] || '')) e++;
    return hit(s, e - s, 'exact');
  }
  if (needle.length < 24) return null;

  const k = Math.min(PREFIX_CHARS, Math.floor(needle.length * 0.6));
  at = hay.norm.indexOf(needle.slice(0, k));
  if (at >= 0) return hit(at, Math.min(needle.length, hay.norm.length - at), 'prefix');

  at = hay.norm.indexOf(needle.slice(-k));
  if (at >= 0) {
    const start = Math.max(0, at + k - needle.length);
    return hit(start, at + k - start, 'suffix');
  }
  return null;
}
