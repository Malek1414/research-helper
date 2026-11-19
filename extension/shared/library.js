// Progress and rotation across sources.
// A source: {id, title, chapters: [{title, start, end, done}], chapter (current index), ...}

export function progress(source) {
  const total = source.chapters?.length || 0;
  const done = (source.chapters || []).filter((c) => c.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

export function nextUnfinished(source, from = 0) {
  const ch = source.chapters || [];
  for (let k = 0; k < ch.length; k++) {
    const i = (from + k) % ch.length;
    if (!ch[i].done) return i;
  }
  return -1;
}

// Next stop in rotation: the next source after the active one (wrapping, the
// active one last) that still has an unfinished chapter.
export function nextInRotation(sources, activeId) {
  if (!sources.length) return null;
  const a = Math.max(0, sources.findIndex((s) => s.id === activeId));
  for (let k = 1; k <= sources.length; k++) {
    const s = sources[(a + k) % sources.length];
    if (!s.chapters?.length) {
      if (s.id !== activeId) return { sourceId: s.id, chapter: 0 };
      continue;
    }
    const i = nextUnfinished(s, s.id === activeId ? s.chapter + 1 : s.chapter || 0);
    if (i >= 0) return { sourceId: s.id, chapter: i };
  }
  return null;
}

export function mergeGlossary(glossary, terms, sourceTitle) {
  const out = { ...glossary };
  for (const { term, definition } of terms || []) {
    const key = term.trim().toLowerCase();
    if (!key) continue;
    const prev = out[key];
    const sources = new Set(prev?.sources || []);
    sources.add(sourceTitle);
    out[key] = { term: prev?.term || term.trim(), definition: prev?.definition || definition.trim(), sources: [...sources] };
  }
  return out;
}
