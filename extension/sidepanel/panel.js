// Side panel: library, progress, rotation, explanations, Q&A, build card, glossary.
import { getState, setState, onChange, removeSource } from '../shared/store.js';
import { getAnalysis } from '../shared/db.js';
import { progress, nextInRotation } from '../shared/library.js';
import { renderMarkdown, escapeHtml as esc } from '../shared/md.js';
import { send, listen } from '../shared/bus.js';
import * as bridge from '../shared/bridge.js';
import { openViewer, importFromUrl, importFromFile, looksLikePdfUrl } from '../shared/open.js';
import { DEFAULT_ABOUT_ME } from '../shared/about.js';

const $ = (id) => document.getElementById(id);
const ui = {
  store: { sources: [], activeId: null, glossary: {}, aboutMe: '' },
  doc: null, // last 'doc' message from the viewer for the active source
  tab: 'walk',
  answers: {}, // `${sourceId}:${chapter}:${section}` -> [{question, answer|error|pending}]
  removing: null,
};

const active = () => ui.store.sources.find((s) => s.id === ui.store.activeId) || null;
const dots = (n) => '●'.repeat(n) + '○'.repeat(5 - n);

async function viewerOpen() {
  const tabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL('viewer/viewer.html')}*` });
  return tabs.length > 0;
}

async function command(msg) {
  const src = active();
  if (!src) return;
  if (!(await viewerOpen())) {
    await openViewer(src.id, msg.cmd === 'open' ? msg.chapter : undefined);
    if (msg.cmd === 'open') return;
    // Give the viewer a moment to load before sending the command.
    await new Promise((r) => setTimeout(r, 1500));
  }
  send({ to: 'viewer', sourceId: src.id, ...msg });
}

// ---------- rendering ----------
function render() {
  const src = active();
  $('source').hidden = !src;
  $('welcome').hidden = !!src || ui.store.sources.length > 0;
  renderLibrary();
  if (!src) return;
  const doc = ui.doc?.sourceId === src.id ? ui.doc : null;
  const chapter = doc ? doc.chapter : src.chapter || 0;
  const p = progress(src);

  $('src-title').textContent = src.title;
  const analysis = doc?.analysis || (ui.cachedAnalysis?.key === `${src.id}:${chapter}` && ui.cachedAnalysis.analysis) || null;
  const secCount = analysis?.sections.length || 0;
  const secAt = Math.min(doc?.section ?? src.section ?? 0, Math.max(0, secCount - 1));
  // Like a context-window bar: done chapters are full, the current one fills as you walk its sections.
  const fill = (c, i) => (c.done ? 100 : i === chapter && secCount ? Math.round(((secAt + 1) / secCount) * 100) : 0);
  $('src-bar').innerHTML = (src.chapters || []).map((c, i) => `<span class="${c.done ? 'done' : ''} ${i === chapter ? 'cur' : ''}" style="--fill:${fill(c, i)}%" title="${esc(`${i + 1}. ${c.title}`)}"></span>`).join('');
  $('src-label').textContent = src.chapters?.length
    ? `${p.done} / ${p.total} chapters understood · ${p.pct}%${secCount && !src.chapters[chapter]?.done ? ` · section ${secAt + 1}/${secCount}` : ''}`
    : 'Splitting into chapters…';
  const ch = src.chapters?.[chapter];
  $('chapter-summary').textContent = ch ? `Chapter ${chapter + 1}: ${ch.title}` : 'Chapters';
  $('chapters').innerHTML = (src.chapters || []).map((c, i) => `
    <li data-ch="${i}" class="${i === chapter ? 'cur' : ''} ${c.done ? 'done' : ''}">
      <span class="tick">${c.done ? '✓' : i + 1}</span><span>${esc(c.title)}</span><span class="pp">p ${c.start + 1}-${c.end + 1}</span>
    </li>`).join('');

  const mode = doc?.mode || src.mode || 'annotate';
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b.dataset.mode === mode);
  $('explain').textContent = doc?.busy ? 'Explaining…' : analysis ? 'Re-explain' : 'Explain chapter';
  $('explain').disabled = !!doc?.busy;
  $('rotate').disabled = !nextInRotation(ui.store.sources, src.id);

  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === ui.tab);
  for (const t of ['walk', 'build', 'gloss']) $(`tab-${t}`).hidden = ui.tab !== t;
  renderWalk(src, chapter, analysis, doc, mode);
  renderBuild(analysis, ch);
  renderGlossary(analysis);
}

function renderWalk(src, chapter, a, doc, mode) {
  const box = $('tab-walk');
  if (!a) {
    box.innerHTML = doc?.busy
      ? '<p class="status busy">Claude is reading this chapter. Highlights and notes appear on the PDF when it is done.</p>'
      : '<p class="status">Press <b>Explain chapter</b>. Claude reads only this chapter, then walks you through it.</p>';
    return;
  }
  const cur = Math.min(doc?.section ?? src.section ?? 0, a.sections.length - 1);
  const card = (s, i) => {
    const key = `${src.id}:${chapter}:${i}`;
    const anchored = doc?.anchored ? doc.anchored[i] : true;
    const qa = (ui.answers[key] || []).map((x) => `
      <div class="qa"><div class="q">${esc(x.question)}</div>
      <div class="body">${x.pending ? '<span class="status busy">Thinking…</span>' : x.error ? `<span class="status error">${esc(x.error)}</span>` : renderMarkdown(x.answer)}</div></div>`).join('');
    return `
      <article class="card ${i === cur ? 'on' : ''}" data-section="${i}">
        <h4><span>${i + 1}. ${esc(s.title)}</span><span class="dots" title="Difficulty ${s.difficulty}/5">${dots(s.difficulty)}</span></h4>
        <div class="meta"><span>p. ${s.page}</span>${anchored ? '' : '<span class="nohl">no highlight found</span>'}</div>
        ${s.note ? `<div class="note-hand">${esc(s.note)}</div>` : ''}
        <div class="body">${renderMarkdown(s.explanation)}</div>
        ${i === cur ? `<div class="ask"><form data-ask="${i}"><input name="q" placeholder="Ask about this part…" autocomplete="off"><button class="small">Ask</button></form>${qa}</div>` : ''}
      </article>`;
  };
  if (mode === 'walk') {
    const last = cur === a.sections.length - 1;
    box.innerHTML = `
      <div class="walk-nav">
        <button id="w-back" class="small" ${cur === 0 ? 'disabled' : ''}>‹ Back</button>
        <span>Section ${cur + 1} of ${a.sections.length}</span>
        ${last ? '<button id="w-finish" class="small primary">Finish chapter ✓</button>' : '<button id="w-next" class="small primary">Next ›</button>'}
      </div>
      ${card(a.sections[cur], cur)}`;
  } else {
    box.innerHTML = a.sections.map(card).join('');
  }
}

function renderBuild(a, ch) {
  const box = $('tab-build');
  if (!a) {
    box.innerHTML = '<p class="status">The build card appears once the chapter is explained.</p>';
    return;
  }
  const b = a.buildCard;
  box.innerHTML = `
    <div class="build">
      <h5>Core idea</h5><div class="core">${renderMarkdown(b.coreIdea)}</div>
      <h5>Where it fits in a product</h5><div class="body"><ul>${b.whereItFits.map((w) => `<li>${renderMarkdown(w).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul></div>
      ${b.sketch ? `<h5>Sketch · ${esc(b.sketchLang)}</h5><pre><code>${esc(b.sketch)}</code></pre><button id="copy-sketch" class="small">Copy sketch</button>` : ''}
      <h5>In short</h5><div class="body">${renderMarkdown(a.summary)}</div>
      <div class="actions">
        <button id="export" class="primary">Export to Neurotree</button>
        <button id="toggle-done">${ch?.done ? 'Mark not done' : 'Mark chapter done'}</button>
      </div>
      <div id="export-status" class="status"></div>
    </div>`;
}

function renderGlossary(a) {
  const filter = $('gloss-filter').value.trim().toLowerCase();
  const all = Object.values(ui.store.glossary).sort((x, y) => x.term.localeCompare(y.term));
  const hits = filter ? all.filter((g) => (g.term + ' ' + g.definition).toLowerCase().includes(filter)) : all;
  const dl = (items, src) => `<dl>${items.map((g) => `<dt>${esc(g.term)}</dt><dd>${esc(g.definition)}${src && g.sources ? ` <span class="src">· ${esc(g.sources.join(', '))}</span>` : ''}</dd>`).join('')}</dl>`;
  $('gloss-list').innerHTML =
    (a && !filter ? `<h5>This chapter (${a.glossary.length})</h5>${dl(a.glossary, false)}` : '') +
    `<h5>${filter ? 'Matches' : 'All sources'} (${hits.length})</h5>${dl(hits, true)}`;
}

function renderLibrary() {
  $('sources').innerHTML = ui.store.sources.map((s) => {
    const p = progress(s);
    return `<li data-src="${s.id}" class="${s.id === ui.store.activeId ? 'on' : ''}">
      <div class="s-row"><span class="s-title">${esc(s.title)}</span>
        <span><span class="s-pct">${p.total ? `${p.pct}%` : '…'}</span>
        <button class="rm" data-rm="${s.id}" title="Remove">${ui.removing === s.id ? 'remove?' : '✕'}</button></span></div>
      <div class="mini">${(s.chapters || []).map((c) => `<span class="${c.done ? 'done' : ''}"></span>`).join('')}</div>
    </li>`;
  }).join('');
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

// ---------- data ----------
async function refreshStore() {
  ui.store = await getState();
  const src = active();
  if (src && !(ui.doc?.sourceId === src.id)) {
    const key = `${src.id}:${src.chapter || 0}`;
    if (ui.cachedAnalysis?.key !== key) ui.cachedAnalysis = { key, analysis: await getAnalysis(src.id, src.chapter || 0) };
  }
  render();
}

async function checkBridge() {
  const ok = await bridge.health();
  $('bridge').className = `bridge ${ok ? 'on' : 'off'}`;
  $('bridge').textContent = ok ? 'bridge on' : 'bridge off';
  $('offline').hidden = ok;
}

async function checkThisTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url || '';
  ui.thisTabUrl = looksLikePdfUrl(url) || /^file:.*\.pdf$/i.test(url) ? url : null;
  $('this-tab').hidden = !ui.thisTabUrl;
}

// ---------- events ----------
listen('panel', (m) => {
  if (m.sourceId && m.sourceId !== ui.store.activeId) return;
  switch (m.type) {
    case 'doc':
      ui.doc = m;
      render();
      break;
    case 'status':
      setStatus(m.text, m.kind);
      break;
    case 'focus':
      if (ui.doc) ui.doc.section = m.section;
      render();
      document.querySelector('.card.on')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    case 'answer': {
      const key = `${m.sourceId}:${ui.doc?.chapter}:${m.section}`;
      const item = (ui.answers[key] || []).find((x) => x.pending && x.question === m.question);
      if (item) Object.assign(item, { pending: false, answer: m.answer, error: m.error });
      render();
      break;
    }
    case 'exported':
      if ($('export-status')) {
        $('export-status').textContent = m.error ? m.error : `Saved ${m.file.replace(/^.*\/research-helper\//, '')}`;
        $('export-status').className = `status ${m.error ? 'error' : ''}`;
      }
      break;
  }
});

onChange(() => refreshStore());

function gotoSection(si) {
  if (ui.doc) ui.doc.section = si;
  command({ cmd: 'focus', section: si });
  render();
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  const chLi = t.closest('#chapters li');
  if (chLi) return command({ cmd: 'open', chapter: Number(chLi.dataset.ch) });

  const rm = t.closest('[data-rm]');
  if (rm) {
    e.stopPropagation();
    if (ui.removing === rm.dataset.rm) {
      ui.removing = null;
      await removeSource(rm.dataset.rm);
    } else {
      ui.removing = rm.dataset.rm;
      renderLibrary();
    }
    return;
  }
  const srcLi = t.closest('#sources li');
  if (srcLi) {
    ui.removing = null;
    return openViewer(srcLi.dataset.src);
  }

  const modeBtn = t.closest('.seg button');
  if (modeBtn) {
    if (ui.doc) ui.doc.mode = modeBtn.dataset.mode;
    render();
    return command({ cmd: 'mode', mode: modeBtn.dataset.mode });
  }
  const tabBtn = t.closest('.tabs button');
  if (tabBtn) {
    ui.tab = tabBtn.dataset.tab;
    return render();
  }
  const cardEl = t.closest('.card');
  if (cardEl && !t.closest('form') && !t.closest('a')) {
    const si = Number(cardEl.dataset.section);
    if (si !== (ui.doc?.section ?? -1)) gotoSection(si);
    return;
  }

  switch (t.id) {
    case 'explain':
      return command({ cmd: 'explain', force: $('explain').textContent === 'Re-explain' });
    case 'rotate': {
      const next = nextInRotation(ui.store.sources, ui.store.activeId);
      if (next) openViewer(next.sourceId, next.chapter);
      return;
    }
    case 'w-next':
      return gotoSection((ui.doc?.section || 0) + 1);
    case 'w-back':
      return gotoSection(Math.max(0, (ui.doc?.section || 0) - 1));
    case 'w-finish':
      command({ cmd: 'done', done: true });
      ui.tab = 'build';
      return render();
    case 'export':
      $('export-status').textContent = 'Exporting…';
      return command({ cmd: 'export' });
    case 'toggle-done': {
      const src = active();
      const ch = src?.chapters?.[ui.doc?.chapter ?? src.chapter];
      return command({ cmd: 'done', done: !ch?.done });
    }
    case 'copy-sketch': {
      const a = ui.doc?.analysis || ui.cachedAnalysis?.analysis;
      await navigator.clipboard.writeText(a?.buildCard.sketch || '');
      t.textContent = 'Copied';
      return;
    }
    case 'copy-cmd':
      await navigator.clipboard.writeText(bridge.START_CMD);
      t.textContent = 'Copied';
      return;
    case 'this-tab':
      try {
        setStatus('Downloading PDF…', 'busy');
        await importFromUrl(ui.thisTabUrl);
        setStatus('');
      } catch (err) {
        setStatus(err.message + (ui.thisTabUrl.startsWith('file:') ? ' (turn on "Allow access to file URLs" for the extension, or use + Add PDF)' : ''), 'error');
      }
      return;
    case 'save-about':
      await setState({ aboutMe: $('about').value.trim() });
      t.textContent = 'Saved';
      setTimeout(() => (t.textContent = 'Save'), 1200);
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'url-form') {
    const url = $('url').value.trim();
    if (!url) return;
    try {
      setStatus('Downloading PDF…', 'busy');
      await importFromUrl(url);
      $('url').value = '';
      setStatus('');
    } catch (err) {
      setStatus(err.message, 'error');
    }
    return;
  }
  if (f.dataset.ask !== undefined) {
    const question = f.q.value.trim();
    if (!question) return;
    const section = Number(f.dataset.ask);
    const key = `${ui.store.activeId}:${ui.doc?.chapter}:${section}`;
    (ui.answers[key] ||= []).push({ question, pending: true });
    render();
    command({ cmd: 'ask', question, section });
  }
});

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await importFromFile(file);
  e.target.value = '';
});
$('gloss-filter').addEventListener('input', () => renderGlossary(ui.doc?.analysis || ui.cachedAnalysis?.analysis));
chrome.tabs.onActivated.addListener(checkThisTab);
chrome.tabs.onUpdated.addListener((_, info) => info.url && checkThisTab());

// ---------- start ----------
$('start-cmd').textContent = bridge.START_CMD;
(async () => {
  await refreshStore();
  $('about').value = ui.store.aboutMe || DEFAULT_ABOUT_ME;
  send({ to: 'viewer', cmd: 'hello' });
  checkBridge();
  checkThisTab();
  setInterval(checkBridge, 15000);
})();
