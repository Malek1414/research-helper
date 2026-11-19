// Opening sources: one viewer tab is reused; switching source reloads it.
import { IS_EXTENSION } from './platform.js';
import { addSource, getState, setState, titleFromUrl } from './store.js';
import { BRIDGE } from './bridge.js';

const VIEWER = () => chrome.runtime.getURL('viewer/viewer.html');

export async function openViewer(id, chapter, { explain = false } = {}) {
  const url = `${VIEWER()}?id=${encodeURIComponent(id)}${Number.isInteger(chapter) ? `&chapter=${chapter}` : ''}${explain ? '&explain=1' : ''}`;
  await setState({ activeId: id });
  const [tab] = await chrome.tabs.query({ url: `${VIEWER()}*` });
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  }
  return chrome.tabs.create({ url });
}

export function looksLikePdfUrl(url) {
  return /^https?:\/\//.test(url || '') && (/\.pdf($|[?#])/i.test(url) || /arxiv\.org\/pdf\//.test(url));
}

// Adds a PDF from a link (or reopens it if it is already in the library).
// The web app downloads through the bridge, since pages cannot fetch other sites' PDFs.
export async function importFromUrl(url, title, { explain = false } = {}) {
  const existing = (await getState()).sources.find((s) => s.url === url);
  if (existing) {
    await openViewer(existing.id, undefined, { explain });
    return existing;
  }
  const res = await fetch(IS_EXTENSION ? url : `${BRIDGE}/fetch?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('That link is not a PDF');
  const src = await addSource({ title: title || titleFromUrl(url), url, bytes, titleLocked: !!title });
  await openViewer(src.id, undefined, { explain });
  return src;
}

export async function importFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const src = await addSource({ title: file.name.replace(/\.pdf$/i, ''), bytes });
  await openViewer(src.id);
  return src;
}
