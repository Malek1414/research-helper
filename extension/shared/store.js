// Library state in chrome.storage.local:
//   sources: [{id, title, url, numPages, chapters:[{title,start,end,done}], chapter, section, mode, addedAt}]
//   activeId, glossary {key: {term, definition, sources}}, aboutMe
import './platform.js';
import { mergeGlossary } from './library.js';
import { putPdf, deletePdf } from './db.js';

const area = chrome.storage.local;

export async function getState() {
  const s = await area.get(['sources', 'activeId', 'glossary', 'aboutMe']);
  return { sources: s.sources || [], activeId: s.activeId || null, glossary: s.glossary || {}, aboutMe: s.aboutMe || '' };
}

export const setState = (patch) => area.set(patch);

export async function getSource(id) {
  return (await getState()).sources.find((s) => s.id === id) || null;
}

// Read-modify-write one source. Small writes, so races between the viewer and panel are harmless.
export async function updateSource(id, fn) {
  const { sources } = await getState();
  const i = sources.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const next = { ...sources[i], ...fn(sources[i]) };
  sources[i] = next;
  await area.set({ sources });
  return next;
}

export async function addSource({ title, url, bytes, titleLocked = false }) {
  const id = crypto.randomUUID();
  await putPdf(id, bytes);
  const { sources } = await getState();
  const src = { id, title: title || 'Untitled PDF', url: url || '', numPages: 0, chapters: [], chapter: 0, section: 0, mode: 'annotate', addedAt: Date.now(), titleLocked };
  await area.set({ sources: [...sources, src], activeId: id });
  return src;
}

export async function removeSource(id) {
  await deletePdf(id);
  const { sources, activeId } = await getState();
  const rest = sources.filter((s) => s.id !== id);
  await area.set({ sources: rest, activeId: activeId === id ? rest[0]?.id || null : activeId });
}

export async function addGlossary(terms, sourceTitle) {
  const { glossary } = await getState();
  const next = mergeGlossary(glossary, terms, sourceTitle);
  await area.set({ glossary: next });
  return next;
}

export const onChange = (fn) => chrome.storage.onChanged.addListener((changes, a) => a === 'local' && fn(changes));

export function titleFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || new URL(url).hostname;
  } catch {
    return 'Untitled PDF';
  }
}
