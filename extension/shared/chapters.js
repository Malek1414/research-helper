// Splits a PDF into chapters. Pages are 0-based, ranges inclusive.
// Order of preference: the PDF's own outline, detected headings, fixed chunks.

export const SMALL_DOC_PAGES = 25;
export const CHUNK_PAGES = 15;
export const MAX_CHAPTER_PAGES = 60;

export function fixedChunks(numPages, size = CHUNK_PAGES, start = 0, end = numPages - 1, prefix = 'Pages') {
  const out = [];
  for (let s = start; s <= end; s += size) {
    const e = Math.min(s + size - 1, end);
    out.push({ title: `${prefix} ${s + 1}-${e + 1}`, start: s, end: e });
  }
  return out;
}

// Turns sorted {title, page, children} markers into ranges covering [from, to].
function rangesFromMarkers(markers, from, to) {
  const items = markers
    .filter((m) => Number.isInteger(m.page) && m.page >= from && m.page <= to)
    .sort((a, b) => a.page - b.page)
    .reduce((acc, m) => {
      const prev = acc.at(-1);
      if (prev && prev.page === m.page) {
        prev.title = [prev.title, m.title].filter((t) => t.trim()).join(' · ');
        prev.children = [...(prev.children || []), ...(m.children || [])];
      } else acc.push({ ...m });
      return acc;
    }, []);
  const out = [];
  if (items.length && items[0].page > from) {
    out.push({ title: 'Front matter', start: from, end: items[0].page - 1, children: [] });
  }
  items.forEach((m, i) => {
    const end = i + 1 < items.length ? items[i + 1].page - 1 : to;
    out.push({ title: m.title.trim() || `Section ${i + 1}`, start: m.page, end, children: m.children || [] });
  });
  return out;
}

function splitLong(ch) {
  const len = ch.end - ch.start + 1;
  if (len <= MAX_CHAPTER_PAGES) return [{ title: ch.title, start: ch.start, end: ch.end }];
  const kids = rangesFromMarkers(ch.children, ch.start, ch.end).filter((k) => k.title !== 'Front matter' || k.end > k.start);
  if (kids.length >= 2) return kids.flatMap(splitLong);
  return fixedChunks(0, CHUNK_PAGES, ch.start, ch.end).map((c) => ({
    ...c,
    title: `${ch.title} (pp ${c.start + 1}-${c.end + 1})`,
  }));
}

export function chaptersFromOutline(outline, numPages) {
  let top = outline || [];
  if (top.length === 1 && (top[0].children || []).length > 1) top = top[0].children;
  const resolved = top.filter((m) => Number.isInteger(m.page));
  if (resolved.length < 2) return null;
  return rangesFromMarkers(resolved, 0, numPages - 1).flatMap(splitLong);
}

export function chaptersFromHeadings(headings, numPages) {
  if (!headings || headings.length < 2) return null;
  return rangesFromMarkers(headings.map((h) => ({ ...h, children: [] })), 0, numPages - 1).flatMap(splitLong);
}

const NAMED_RE = /^(chapter|part)\s+([0-9]+|[ivxlc]+)\b/i;
const NUMBERED_RE = /^([0-9]{1,2})\.?\s+([A-Z][^.]*)$/; // "3 Storage and Retrieval", not "3.1 ..." or sentences

// pages: [{page, lines: [{text, size, y}]}], y is 0 (top) .. 1 (bottom).
// Two kinds of headings: big "Chapter N" / "Part N" lines, or top-level numbered
// headings ("1 Introduction", "2 Overview", ...) that are larger than body text
// and whose numbers run in sequence.
export function detectHeadings(pages) {
  const sizes = pages.flatMap((p) => p.lines.map((l) => l.size)).sort((a, b) => a - b);
  if (!sizes.length) return [];
  const median = sizes[Math.floor(sizes.length / 2)];

  const named = [];
  for (const p of pages) {
    const hit = p.lines.find((l) => l.text.trim().length <= 60 && l.size >= median * 1.3 && NAMED_RE.test(l.text.trim()));
    if (hit) named.push({ page: p.page, title: hit.text.trim() });
  }
  if (named.length >= 2) return named;

  const numbered = [];
  let expect = 1;
  for (const p of pages) {
    for (const l of p.lines) {
      const t = l.text.trim();
      const m = t.length <= 60 && l.size >= median * 1.15 && t.match(NUMBERED_RE);
      if (m && Number(m[1]) === expect) {
        numbered.push({ page: p.page, title: t });
        expect++;
        break;
      }
    }
  }
  return numbered.length >= 3 ? numbered : [];
}

export function splitChapters({ outline, headings, numPages }) {
  // Papers and short docs are read in one go; their sections become the walkthrough.
  if (numPages <= SMALL_DOC_PAGES) return [{ title: 'Whole document', start: 0, end: numPages - 1 }];
  const fromOutline = chaptersFromOutline(outline, numPages);
  if (fromOutline) return fromOutline;
  return chaptersFromHeadings(headings, numPages) || fixedChunks(numPages);
}
