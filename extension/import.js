// chrome-extension://<id>/import.html?url=<pdf>&title=<title>&explain=1
// Used by the Claude Code plugin to hand a paper to the extension.
import { importFromUrl } from './shared/open.js';

const q = new URLSearchParams(location.search);
const msg = document.getElementById('msg');
try {
  const url = q.get('url');
  if (!url) throw new Error('No url given.');
  const self = await chrome.tabs.getCurrent();
  await importFromUrl(url, q.get('title') || undefined, { explain: q.get('explain') === '1' });
  if (self) chrome.tabs.remove(self.id);
} catch (e) {
  msg.textContent = `Could not add the paper: ${e.message}`;
  msg.className = 'err';
}
