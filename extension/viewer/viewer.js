// The PDF tab. Owns the document: splits it into chapters, renders the current
// chapter, asks the bridge for an analysis, and draws highlights + notes.
import '../shared/platform.js';
import * as pdfjsLib from '../vendor/pdf.mjs';
import { splitChapters, detectHeadings, SMALL_DOC_PAGES } from '../shared/chapters.js';
import { getSource, updateSource, getState, addGlossary } from '../shared/store.js';
import { getPdf, getAnalysis, putAnalysis } from '../shared/db.js';
import * as bridge from '../shared/bridge.js';
import { send, listen } from '../shared/bus.js';
import { textNodes, anchorRects, drawHighlight, drawNote } from './annotate.js';
import { openViewer } from '../shared/open.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.mjs';

const GUTTER = 250;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const state = {
  id: params.get('id'),
  source: null,
  pdf: null,
  chapter: 0,
  analysis: null,
  anchors: [], // per section: [{page, rects}] in the current layout
  pages: new Map(), // page index -> {wrap, pageEl, hlSvg, inkSvg, nodes, text, width, height}
  zoom: 1,
  scale: 1,
  busy: false,
  section: 0,
  mode: 'annotate',
  autoExplain: params.get('explain') === '1',
};

// ---------- status ----------
function status(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
  send({ to: 'panel', type: 'status', sourceId: state.id, text, kind });
}

function docMessage() {
  const s = state.source;
  return {
    to: 'panel', type: 'doc', sourceId: s.id, title: s.title, chapters: s.chapters, chapter: state.chapter,
    analysis: state.analysis, anchored: state.anchors.map((a) => a.length > 0), section: state.section, mode: state.mode, busy: state.busy,
  };
}

// ---------- loading ----------
async function resolveOutline(pdf, items, depth = 0) {
  return Promise.all((items || []).map(async (it) => {
    let page = null;
    try {
      const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
      if (Array.isArray(dest)) page = Number.isInteger(dest[0]) ? dest[0] : await pdf.getPageIndex(dest[0]);
    } catch { /* unresolvable entry */ }
    return { title: it.title || '', page, children: depth < 1 ? await resolveOutline(pdf, it.items, depth + 1) : [] };
  }));
}

async function pageLines(pdf, i) {
  const page = await pdf.getPage(i + 1);
  const h = page.view[3] - page.view[1];
  const tc = await page.getTextContent();
  const lines = [];
  let cur = null;
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const size = Math.hypot(it.transform[2], it.transform[3]);
    cur ||= { text: '', size: 0, y: 1 - (it.transform[5] - page.view[1]) / h };
    cur.text += it.str;
    cur.size = Math.max(cur.size, size);
    if (it.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur?.text.trim()) lines.push(cur);
  page.cleanup();
  return lines;
}

async function computeChapters(pdf) {
  const numPages = pdf.numPages;
  if (numPages <= SMALL_DOC_PAGES) return splitChapters({ outline: [], headings: [], numPages }).map((c) => ({ ...c, done: false }));
  const outline = await resolveOutline(pdf, await pdf.getOutline());
  let headings = [];
  if (!outline.some((o) => Number.isInteger(o.page)) && numPages > SMALL_DOC_PAGES) {
    const pages = [];
    for (let i = 0; i < numPages; i++) {
      if (i % 10 === 0) status(`Finding chapters… page ${i + 1} of ${numPages}`, 'busy');
      pages.push({ page: i, lines: await pageLines(pdf, i) });
    }
    headings = detectHeadings(pages);
  }
  return splitChapters({ outline, headings, numPages }).map((c) => ({ ...c, done: false }));
}

async function load() {
  if (!state.id) return showEmpty('No source yet. Add a PDF in the <b>Research Helper</b> panel (+ Add PDF, or paste a link).');
  state.source = await getSource(state.id);
  const bytes = state.source && (await getPdf(state.id));
  if (!bytes) return showEmpty('This source is gone from your library. Add it again from the side panel.');
  document.title = `${state.source.title} · Research Helper`;
  $('title').textContent = state.source.title;
  status('Opening PDF…', 'busy');
  state.pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  if (!state.source.chapters?.length || state.source.numPages !== state.pdf.numPages) {
    const chapters = await computeChapters(state.pdf);
    const firstLoad = !state.source.chapters?.length;
    const metaTitle = String((await state.pdf.getMetadata().catch(() => null))?.info?.Title || '').trim();
    const useMeta = firstLoad && !state.source.titleLocked && metaTitle.length >= 4 && metaTitle.length <= 160 && !/^(untitled|microsoft word|document\d*$)/i.test(metaTitle);
    state.source = await updateSource(state.id, () => ({ chapters, numPages: state.pdf.numPages, ...(useMeta ? { title: metaTitle } : {}) }));
    document.title = `${state.source.title} · Research Helper`;
    $('title').textContent = state.source.title;
  }
  state.mode = state.source.mode || 'annotate';
  const want = Number(params.get('chapter'));
  const chapter = Number.isInteger(want) && params.has('chapter') ? want : state.source.chapter || 0;
  fillChapterSelect();
  await showChapter(Math.min(chapter, state.source.chapters.length - 1), { section: params.has('chapter') ? 0 : state.source.section || 0 });
}

function showEmpty(html) {
  $('empty').innerHTML = html;
  $('empty').hidden = false;
  $('pages').hidden = true;
  status('');
  for (const b of ['explain', 'prev-ch', 'next-ch', 'chapter']) $(b).disabled = true;
}

function fillChapterSelect() {
  const sel = $('chapter');
  sel.innerHTML = '';
  state.source.chapters.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${c.done ? '✓ ' : ''}${i + 1}. ${c.title}  (p ${c.start + 1}-${c.end + 1})`;
    sel.appendChild(o);
  });
}

// ---------- rendering ----------
function fitScale(page) {
  const vp = page.getViewport({ scale: 1 });
  const avail = $('main').clientWidth - GUTTER - 96;
  return Math.max(0.5, Math.min(avail / vp.width, 2)) * state.zoom;
}

const canvasObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) renderCanvas(Number(e.target.dataset.page));
}, { root: $('main'), rootMargin: '600px 0px' });

async function renderCanvas(i) {
  const p = state.pages.get(i);
  if (!p || p.canvasDone) return;
  p.canvasDone = true;
  const page = await state.pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: state.scale });
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * ratio);
  canvas.height = Math.floor(vp.height * ratio);
  p.pageEl.prepend(canvas);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
}

async function buildPage(i, token) {
  const page = await state.pdf.getPage(i + 1);
  if (token !== state.renderToken) return;
  const vp = page.getViewport({ scale: state.scale });
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.dataset.page = i;
  wrap.style.width = `${vp.width + GUTTER}px`;
  wrap.style.height = `${vp.height}px`;
  wrap.innerHTML = `<div class="page-num">${i + 1}</div><div class="gutter-bg" style="left:${vp.width}px;width:${GUTTER}px"></div>`;
  const pageEl = document.createElement('div');
  pageEl.className = 'page';
  pageEl.style.width = `${vp.width}px`;
  pageEl.style.height = `${vp.height}px`;
  pageEl.style.setProperty('--scale-factor', state.scale);
  pageEl.style.setProperty('--total-scale-factor', state.scale);
  const hlSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  hlSvg.classList.add('hl-layer');
  const textLayerEl = document.createElement('div');
  textLayerEl.className = 'textLayer';
  pageEl.append(hlSvg, textLayerEl);
  const inkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  inkSvg.classList.add('ink-layer');
  inkSvg.setAttribute('width', vp.width + GUTTER);
  inkSvg.setAttribute('height', vp.height);
  wrap.append(pageEl, inkSvg);
  $('pages').appendChild(wrap);

  const tc = await page.getTextContent();
  const layer = new pdfjsLib.TextLayer({ textContentSource: tc, container: textLayerEl, viewport: vp });
  await layer.render();
  const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
  state.pages.set(i, { wrap, pageEl, hlSvg, inkSvg, textLayerEl, nodes: textNodes(textLayerEl), text, width: vp.width, height: vp.height });
  canvasObserver.observe(wrap);
  pageEl.addEventListener('click', (e) => onPageClick(i, e));
}

async function showChapter(index, { section = 0 } = {}) {
  state.chapter = index;
  state.renderToken = Symbol('render');
  const token = state.renderToken;
  const ch = state.source.chapters[index];
  $('chapter').value = index;
  $('prev-ch').disabled = index === 0;
  $('next-ch').disabled = index === state.source.chapters.length - 1;
  canvasObserver.disconnect();
  state.pages.clear();
  $('pages').innerHTML = '';
  $('pages').hidden = false;
  $('empty').hidden = true;
  $('main').scrollTop = 0;
  status(`Rendering pages ${ch.start + 1}-${ch.end + 1}…`, 'busy');
  state.scale = fitScale(await state.pdf.getPage(ch.start + 1));
  for (let i = ch.start; i <= ch.end; i++) {
    await buildPage(i, token);
    if (token !== state.renderToken) return;
  }
  const end = document.createElement('div');
  end.className = 'chapter-end';
  end.innerHTML = index < state.source.chapters.length - 1
    ? `End of chapter ${index + 1}. <button id="end-next">Next chapter ›</button>`
    : 'End of the document.';
  $('pages').appendChild(end);
  end.querySelector('#end-next')?.addEventListener('click', () => gotoChapter(index + 1));

  await document.fonts.load('600 20px Caveat');
  state.analysis = (await getAnalysis(state.id, index)) || null;
  state.section = Math.min(section, (state.analysis?.sections.length || 1) - 1);
  await updateSource(state.id, () => ({ chapter: index, section: state.section }));
  const chars = [...state.pages.values()].reduce((n, p) => n + p.text.trim().length, 0);
  state.noText = chars < 40 * (ch.end - ch.start + 1);
  drawAnnotations();
  $('explain').textContent = state.analysis ? 'Re-explain' : 'Explain chapter';
  status(state.noText ? 'No text layer in these pages: this PDF needs OCR first.' : state.analysis ? `${state.analysis.sections.length} sections explained` : 'Ready', state.noText ? 'error' : '');
  $('explain').disabled = state.noText;
  send(docMessage());
  if (state.analysis && state.section > 0) focusSection(state.section, { scroll: true });
  if (state.autoExplain && !state.analysis && !state.noText) {
    state.autoExplain = false;
    explain();
  }
}

function gotoChapter(i) {
  if (i < 0 || i >= state.source.chapters.length) return;
  showChapter(i);
}

// ---------- annotations ----------
function drawAnnotations({ animateSection = -1 } = {}) {
  for (const p of state.pages.values()) {
    p.hlSvg.innerHTML = '';
    p.inkSvg.innerHTML = '';
  }
  state.anchors = [];
  const a = state.analysis;
  if (!a) return;
  const noteBottom = new Map();
  a.sections.forEach((s, si) => {
    const found = [];
    for (const anchor of s.anchors) {
      const p = state.pages.get(anchor.page - 1);
      if (!p) continue;
      const hit = anchorRects(p.pageEl, p.nodes, anchor.quote);
      if (hit) found.push({ page: anchor.page - 1, rects: hit.rects });
    }
    state.anchors[si] = found;
    const visible = state.mode === 'annotate' || si <= state.section;
    if (!visible) return;
    for (const f of found) drawHighlight(state.pages.get(f.page).hlSvg, f.rects, s.difficulty, si);
    if (s.note && found.length) {
      const f = found[0];
      const p = state.pages.get(f.page);
      noteBottom.set(f.page, drawNote(p.inkSvg, {
        rects: f.rects, note: s.note, pageWidth: p.width, gutter: GUTTER, minY: noteBottom.get(f.page) || 6,
        section: si, animate: si === animateSection, scale: state.scale,
      }));
    }
  });
}

function focusSection(si, { scroll = true, animate = false } = {}) {
  if (!state.analysis) return;
  state.section = si;
  updateSource(state.id, () => ({ section: si }));
  if (state.mode === 'walk' || animate) drawAnnotations({ animateSection: state.mode === 'walk' ? si : -1 });
  const s = state.analysis.sections[si];
  const target = state.anchors[si]?.[0];
  if (scroll) {
    const pageIdx = target ? target.page : s.page - 1;
    const p = state.pages.get(pageIdx);
    if (p) {
      const y = p.wrap.offsetTop + (target ? target.rects[0].y : 0) - $('main').clientHeight * 0.3;
      $('main').scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }
  for (const g of document.querySelectorAll(`.hl[data-section="${si}"]`)) {
    g.classList.remove('flash');
    void g.getBoundingClientRect();
    g.classList.add('flash');
  }
}

function onPageClick(pageIdx, e) {
  if (!state.analysis || window.getSelection()?.toString()) return;
  const p = state.pages.get(pageIdx);
  const base = p.pageEl.getBoundingClientRect();
  const x = e.clientX - base.left;
  const y = e.clientY - base.top;
  const si = state.anchors.findIndex((found, i) =>
    (state.mode === 'annotate' || i <= state.section) &&
    found?.some((f) => f.page === pageIdx && f.rects.some((r) => x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2)));
  if (si >= 0) {
    focusSection(si, { scroll: false });
    send({ to: 'panel', type: 'focus', sourceId: state.id, section: si });
  }
}

// ---------- AI ----------
function chapterText(ch) {
  const parts = [];
  for (let i = ch.start; i <= ch.end; i++) parts.push(`[[p ${i + 1}]]\n${state.pages.get(i)?.text || ''}`);
  return parts.join('\n\n');
}

async function storySoFar() {
  const out = [];
  for (let i = Math.max(0, state.chapter - 6); i < state.chapter; i++) {
    const a = await getAnalysis(state.id, i);
    if (a?.summary) out.push(`- Chapter ${i + 1} (${state.source.chapters[i].title}): ${a.summary}`);
  }
  return out.join('\n');
}

async function explain({ force = false } = {}) {
  if (state.busy || state.noText) return;
  const ch = state.source.chapters[state.chapter];
  const chapter = state.chapter;
  state.busy = true;
  $('explain').disabled = true;
  status('Claude is reading the chapter… (usually 1-3 min)', 'busy');
  send(docMessage());
  try {
    const { aboutMe } = await getState();
    const res = await bridge.analyze({
      sourceTitle: state.source.title, chapterTitle: ch.title, pageRange: [ch.start + 1, ch.end + 1],
      text: chapterText(ch), storySoFar: await storySoFar(), aboutMe, force,
    });
    delete res.cached;
    await putAnalysis(state.id, chapter, res);
    await addGlossary(res.glossary, state.source.title);
    if (chapter !== state.chapter) return;
    state.analysis = res;
    state.section = 0;
    drawAnnotations({ animateSection: state.mode === 'walk' ? 0 : -1 });
    const missing = state.anchors.filter((f) => !f.length).length;
    status(`${res.sections.length} sections explained${missing ? `, ${missing} without a highlight` : ''}`);
    $('explain').textContent = 'Re-explain';
    if (state.mode === 'walk') focusSection(0);
  } catch (e) {
    status(e.message, 'error');
  } finally {
    state.busy = false;
    $('explain').disabled = false;
    send(docMessage());
  }
}

async function ask({ question, section }) {
  const s = state.analysis?.sections[section];
  const page = s ? s.page - 1 : state.source.chapters[state.chapter].start;
  const pageText = [page - 1, page, page + 1].map((i) => state.pages.get(i)?.text || '').join('\n').slice(0, 12000);
  try {
    const { aboutMe } = await getState();
    const { answer } = await bridge.ask({
      aboutMe, sourceTitle: state.source.title, chapterTitle: state.source.chapters[state.chapter].title, section: s, pageText, question,
    });
    send({ to: 'panel', type: 'answer', sourceId: state.id, section, question, answer });
  } catch (e) {
    send({ to: 'panel', type: 'answer', sourceId: state.id, section, question, error: e.message });
  }
}

async function markDone(done = true) {
  state.source = await updateSource(state.id, (s) => ({
    chapters: s.chapters.map((c, i) => (i === state.chapter ? { ...c, done } : c)),
  }));
  fillChapterSelect();
  $('chapter').value = state.chapter;
  send(docMessage());
}

async function doExport() {
  if (!state.analysis) return;
  try {
    const { glossary } = await getState();
    const res = await bridge.exportChapter({
      source: { id: state.id, title: state.source.title, url: state.source.url },
      chapterIndex: state.chapter, chapter: state.source.chapters[state.chapter], analysis: state.analysis, glossary,
    });
    await markDone(true);
    send({ to: 'panel', type: 'exported', sourceId: state.id, file: res.file });
    status('Exported to library/ for Neurotree');
  } catch (e) {
    send({ to: 'panel', type: 'exported', sourceId: state.id, error: e.message });
  }
}

// ---------- wiring ----------
listen('viewer', async (m) => {
  if (m.cmd === 'hello') return state.source && send(docMessage());
  if (m.sourceId && m.sourceId !== state.id) {
    if (m.cmd === 'open') openViewer(m.sourceId, m.chapter);
    return;
  }
  switch (m.cmd) {
    case 'open': if (Number.isInteger(m.chapter) && m.chapter !== state.chapter) gotoChapter(m.chapter); break;
    case 'explain': explain({ force: !!m.force }); break;
    case 'focus': focusSection(m.section, { scroll: true }); break;
    case 'mode':
      state.mode = m.mode;
      await updateSource(state.id, () => ({ mode: m.mode }));
      drawAnnotations({ animateSection: m.mode === 'walk' ? state.section : -1 });
      if (m.mode === 'walk') focusSection(state.section);
      send(docMessage());
      break;
    case 'ask': ask(m); break;
    case 'done': markDone(m.done !== false); break;
    case 'export': doExport(); break;
  }
});

$('chapter').addEventListener('change', (e) => gotoChapter(Number(e.target.value)));
$('prev-ch').addEventListener('click', () => gotoChapter(state.chapter - 1));
$('next-ch').addEventListener('click', () => gotoChapter(state.chapter + 1));
$('explain').addEventListener('click', () => explain({ force: !!state.analysis }));
$('panel').addEventListener('click', async () => {
  const win = await chrome.windows.getCurrent();
  chrome.sidePanel.open({ windowId: win.id });
});
const rezoom = (f) => {
  state.zoom = Math.max(0.5, Math.min(2.5, state.zoom * f));
  showChapter(state.chapter, { section: state.section });
};
$('zoom-in').addEventListener('click', () => rezoom(1.15));
$('zoom-out').addEventListener('click', () => rezoom(1 / 1.15));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (!state.analysis) return;
  const n = state.analysis.sections.length;
  if (e.key === 'ArrowRight' || e.key === 'j') {
    const si = Math.min(n - 1, state.section + 1);
    focusSection(si, { animate: true });
    send({ to: 'panel', type: 'focus', sourceId: state.id, section: si });
  } else if (e.key === 'ArrowLeft' || e.key === 'k') {
    const si = Math.max(0, state.section - 1);
    focusSection(si);
    send({ to: 'panel', type: 'focus', sourceId: state.id, section: si });
  }
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.pdf && showChapter(state.chapter, { section: state.section }), 300);
});

load().catch((e) => {
  console.error(e);
  status(`Could not open this PDF: ${e.message}`, 'error');
});
