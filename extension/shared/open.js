// Opening sources: one viewer tab is reused; switching source reloads it.
import { addSource, setState, titleFromUrl } from './store.js';

const VIEWER = () => chrome.runtime.getURL('viewer/viewer.html');

export async function openViewer(id, chapter) {
  const url = `${VIEWER()}?id=${encodeURIComponent(id)}${Number.isInteger(chapter) ? `&chapter=${chapter}` : ''}`;
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

export async function importFromUrl(url, title) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('That link is not a PDF');
  const src = await addSource({ title: title || titleFromUrl(url), url, bytes });
  await openViewer(src.id);
  return src;
}

export async function importFromFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const src = await addSource({ title: file.name.replace(/\.pdf$/i, ''), bytes });
  await openViewer(src.id);
  return src;
}
