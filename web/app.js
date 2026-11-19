// Localhost web app: the extension's viewer (left) and side panel (right) in one
// page, sharing storage through the platform shim.
//   /?add=<pdf url>&title=<title>&explain=1   add a paper (or reopen it) and start explaining
//   /?open=<source id>[&chapter=N]            open a source from the library
import '/extension/shared/platform.js';
import { importFromUrl, openViewer } from '/extension/shared/open.js';
import { getState } from '/extension/shared/store.js';

const viewer = document.getElementById('viewer');
const panel = document.getElementById('panel');
const VIEWER = '/extension/viewer/viewer.html';

window.rhApp = {
  viewerUrl: () => viewer.src || new URL(VIEWER, location.origin).href,
  openUrl(url) {
    viewer.src = url;
    const id = new URL(url).searchParams.get('id');
    if (id) document.title = 'Research Helper';
  },
};

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 12000);
}

// Resizable divider, remembered per browser.
const split = document.getElementById('split');
const handle = document.getElementById('handle');
try {
  const w = localStorage.getItem('rh-web:panel-w');
  if (w) split.style.setProperty('--panel-w', w);
} catch {}
handle.addEventListener('pointerdown', (e) => {
  handle.setPointerCapture(e.pointerId);
  split.classList.add('dragging');
  handle.classList.add('drag');
});
handle.addEventListener('pointermove', (e) => {
  if (!handle.hasPointerCapture(e.pointerId)) return;
  const w = `${Math.max(320, Math.min(window.innerWidth - 400, window.innerWidth - e.clientX))}px`;
  split.style.setProperty('--panel-w', w);
});
handle.addEventListener('pointerup', (e) => {
  handle.releasePointerCapture(e.pointerId);
  split.classList.remove('dragging');
  handle.classList.remove('drag');
  try { localStorage.setItem('rh-web:panel-w', split.style.getPropertyValue('--panel-w')); } catch {}
});

const q = new URLSearchParams(location.search);
history.replaceState(null, '', '/');
panel.src = '/extension/sidepanel/panel.html';

if (q.get('add')) {
  importFromUrl(q.get('add'), q.get('title') || undefined, { explain: q.get('explain') === '1' }).catch((e) => {
    showError(`Could not add that PDF: ${e.message}`);
    viewer.src = VIEWER;
  });
} else if (q.get('open')) {
  const ch = Number(q.get('chapter'));
  openViewer(q.get('open'), Number.isInteger(ch) && q.has('chapter') ? ch : undefined, { explain: q.get('explain') === '1' });
} else {
  getState().then(({ activeId }) => {
    viewer.src = activeId ? `${VIEWER}?id=${encodeURIComponent(activeId)}` : VIEWER;
  });
}
