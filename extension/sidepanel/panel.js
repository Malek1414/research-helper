// Side panel: library, progress, rotation, explanations, Q&A, build card, glossary.
import '../shared/platform.js';
import { getState, setState, onChange, removeSource } from '../shared/store.js';
import { getAnalysis, getVisuals } from '../shared/db.js';
import { layoutVisual, layoutMap } from '../shared/visual-layout.js';
import { drawWhiteboard } from './whiteboard.js';
import { codeHtml, stateHtml } from '../shared/trace-view.js';
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
  wb: {}, // `${sourceId}:${chapter}:${section}` -> {step}
  autoKey: null, // the whiteboard that last auto-played
  timer: null,
  openMore: new Set(), // "Full explanation" boxes left open
  seen: {}, // `${sourceId}:${chapter}` -> sections already shown (new ones animate in)
  chaptersOpen: false,
  menuOpen: false,
  drawerOpen: false,
};
const STEP_MS = 3400;
const TRACE_MS = 1700;
// Code tab: pick = {title, code, language} being traced; traces cached per code.
ui.code = { pick: null, trace: null, busy: false, error: '', step: 0, own: '', ownLang: 'auto' };

const active = () => ui.store.sources.find((s) => s.id === ui.store.activeId) || null;
const diffDots = (n) => `<span class="diff" title="Difficulty ${n}/5">${[1, 2, 3, 4, 5].map((k) => `<i class="${k <= n ? 'on' : ''}"></i>`).join('')}</span>`;
const pad = (n) => String(n).padStart(2, '0');
// A timeline: a hairline with one dot per item (done = red, current = red ring).
const track = (items, cur, cls = '') => `<div class="track ${items.length > 24 ? 'many' : ''} ${cls}">${items.map((it, i) => `<span class="${it.done ? 'done' : ''} ${i === cur ? 'cur' : ''} ${it.part ? 'part' : ''}" title="${esc(it.title || '')}"></span>`).join('')}</div>`;
const secs = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
};

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
  $('welcome').hidden = !!src;
  $('drawer').hidden = $('scrim').hidden = !ui.drawerOpen;
  $('menu').hidden = !ui.menuOpen;
  $('src-title').textContent = src ? src.title : 'Research Helper';
  renderLibrary();
  if (!src) {
    $('progress').hidden = true;
    return;
  }
  const doc = ui.doc?.sourceId === src.id ? ui.doc : null;
  const chapter = doc ? doc.chapter : src.chapter || 0;
  const p = progress(src);

  const analysis = doc?.analysis || (ui.cachedAnalysis?.key === `${src.id}:${chapter}` && ui.cachedAnalysis.analysis) || null;
  const secCount = analysis?.sections.length || 0;
  const secAt = Math.min(doc?.section ?? src.section ?? 0, Math.max(0, secCount - 1));
  const ch = src.chapters?.[chapter];
  // One chapter: the timeline shows its sections. Several: one dot per chapter.
  const many = (src.chapters?.length || 0) > 1;
  $('src-bar').outerHTML = many
    ? track(src.chapters.map((c, i) => ({ done: c.done, title: `${i + 1}. ${c.title}`, part: i === chapter && !c.done && secCount })), chapter).replace('class="track', 'id="src-bar" class="track')
    : track((analysis?.sections || []).map((s, i) => ({ done: ch?.done || i < secAt, title: s.title })), secAt).replace('class="track', 'id="src-bar" class="track');
  $('src-label').textContent = !src.chapters?.length ? 'Splitting into chapters'
    : `${p.pct}% understood${secCount ? ` · section ${secAt + 1} of ${secCount}` : ''}`;
  $('ch-no').textContent = ch ? `Chapter ${chapter + 1} of ${src.chapters.length} · pages ${ch.start + 1}–${ch.end + 1}` : '';
  $('chapter-summary').textContent = ch ? ch.title : '';
  const preparing = new Set(doc?.prefetching || []);
  $('chapters').hidden = !ui.chaptersOpen;
  $('chapters').innerHTML = (src.chapters || []).map((c, i) => `
    <li data-ch="${i}" class="${i === chapter ? 'cur' : ''} ${c.done ? 'done' : ''}">
      <span class="tick">${c.done ? '✓' : i + 1}</span><span>${esc(c.title)}${preparing.has(i) ? '<span class="ready">● preparing</span>' : ''}</span><span class="pp">p ${c.start + 1}-${c.end + 1}</span>
    </li>`).join('');

  const mode = doc?.mode || src.mode || 'annotate';
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
  $('explain').textContent = analysis ? 'Re-explain chapter' : 'Explain chapter';
  $('explain').disabled = !!doc?.busy;
  $('redraw').disabled = !analysis || !!doc?.visualBusy;
  $('rotate').disabled = !nextInRotation(ui.store.sources, src.id);

  const view = ui.store.view;
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === view);
  const visuals = doc ? doc.visuals : (ui.cachedVisuals?.key === `${src.id}:${chapter}` && ui.cachedVisuals.visuals) || null;
  renderProgress(doc, analysis, view);
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === ui.tab);
  for (const t of ['walk', 'build', 'code', 'gloss']) $(`tab-${t}`).hidden = ui.tab !== t;
  renderWalk(src, chapter, analysis, doc, mode, view === 'visual' ? visuals : null);
  renderBuild(analysis, ch);
  renderGlossary(analysis);
  if (ui.tab === 'code') renderCode(src, doc, analysis);
}

// Live progress while Claude works, told like a slide: a lead-in, one big number, a hairline.
function renderProgress(doc, analysis, view) {
  const pr = doc?.progress;
  const drawing = view === 'visual' && doc?.visualBusy;
  const show = !!(doc?.busy || drawing) && !!pr;
  $('progress').hidden = !show;
  clearInterval(ui.clock);
  if (!show) return;
  const total = analysis?.sections.length || 0;
  let fill = null;
  if (pr.phase === 'reading') {
    $('progress-text').textContent = 'Claude is reading the chapter.';
    $('progress-big').textContent = '';
    $('progress-unit').textContent = 'First section in a few seconds';
  } else if (pr.phase === 'writing') {
    $('progress-text').textContent = `Writing section ${pr.sections + 1}.`;
    $('progress-big').textContent = pr.sections;
    $('progress-unit').textContent = pr.sections === 1 ? 'section ready' : 'sections ready';
  } else {
    $('progress-text').textContent = 'Drawing the pictures.';
    $('progress-big').textContent = `${pr.drawn}/${total}`;
    $('progress-unit').textContent = 'drawn';
    fill = total ? Math.max(3, Math.round((pr.drawn / total) * 100)) : 0;
  }
  $('progress').classList.toggle('indeterminate', fill === null);
  $('progress-fill').style.width = fill === null ? '' : `${fill}%`;
  const tick = () => ($('progress-time').textContent = secs(Date.now() - pr.startedAt));
  tick();
  ui.clock = setInterval(tick, 1000);
}

const skeleton = (label) => `<article class="sec skeleton">${label ? `<p class="q"><span class="dot-spin"></span>${label}</p>` : ''}<div class="bar t"></div><div class="bar s"></div><div class="bar xs"></div></article>`;

function renderWalk(src, chapter, a, doc, mode, visuals) {
  const box = $('tab-walk');
  if (!a) {
    const ch = src.chapters?.[chapter];
    box.innerHTML = doc?.busy
      ? skeleton('Reading the chapter.') + skeleton() + skeleton()
      : `<div class="cta">
          <p class="q">${ch ? `${ch.end - ch.start + 1} pages, not explained yet.` : 'Not explained yet.'}</p>
          <h2>Claude reads this chapter and draws every idea.</h2>
          <p class="sub">Highlights land on the PDF. Sections appear one by one as they are written.</p>
          <button id="explain-cta" class="primary">Explain this chapter</button>
          <p class="pill">First section in about 10 seconds</p>
        </div>`;
    return;
  }
  const partial = a.buildCard === null;
  const seenKey = `${src.id}:${chapter}`;
  const seen = ui.seen[seenKey] ?? (partial ? 0 : a.sections.length);
  ui.seen[seenKey] = a.sections.length;
  const cur = Math.min(doc?.section ?? src.section ?? 0, a.sections.length - 1);
  const visual = ui.store.view === 'visual';
  const card = (s, i) => {
    const key = `${src.id}:${chapter}:${i}`;
    const anchored = doc?.anchored ? doc.anchored[i] : true;
    const qa = (ui.answers[key] || []).map((x) => `
      <div class="qa"><p class="q">${esc(x.question)}</p>
      <div class="body">${x.pending ? '<span class="status busy">Thinking</span>' : x.error ? `<span class="status error">${esc(x.error)}</span>` : renderMarkdown(x.answer)}</div></div>`).join('');
    const askBox = i === cur ? `<div class="ask"><form data-ask="${i}"><input name="q" placeholder="Ask about this part" autocomplete="off"><button class="link">Ask</button></form>${qa}</div>` : '';
    const v = visuals?.sections?.[i];
    const meta = `<div class="sec-meta pill"><span class="num">${pad(i + 1)}</span><span class="page-link" data-page-sec="${i}" title="Show it on the PDF">p. ${s.page}</span>${diffDots(s.difficulty)}${anchored ? '' : '<span class="warn">no highlight</span>'}${visual && !v && (doc?.visualBusy || doc?.busy) ? '<span class="drawing">drawing</span>' : ''}</div>`;
    const cls = `sec ${i === cur ? 'on' : ''} ${i >= seen ? 'fresh' : ''}`;
    if (v) {
      return `
      <article class="${cls}" data-section="${i}">
        ${meta}
        <div class="sec-head"><p class="q">${esc(s.title)}</p><h2>${esc(v.oneLiner || s.title)}</h2></div>
        <div class="wb" data-wb="${i}"></div>
        <div class="wb-cap" data-cap="${i}"></div>
        <div class="wb-ctl">
          <button class="link" data-wb-prev="${i}" title="Previous step">‹</button>
          <span class="wb-dots" data-dots="${i}"></span>
          <button class="link" data-wb-next="${i}" title="Next step">›</button>
          <button class="link play" data-wb-play="${i}">Play</button>
        </div>
        ${s.note ? `<div class="note-hand">${esc(s.note)}</div>` : ''}
        <details class="more" data-more="${key}" ${ui.openMore.has(key) ? 'open' : ''}><summary>Full explanation</summary><div class="body">${renderMarkdown(s.explanation)}</div></details>
        ${askBox}
      </article>`;
    }
    return `
      <article class="${cls} text" data-section="${i}">
        ${meta}
        <div class="sec-head"><h2>${esc(s.title)}</h2></div>
        ${s.note ? `<div class="note-hand">${esc(s.note)}</div>` : ''}
        <div class="body">${renderMarkdown(s.explanation)}</div>
        ${askBox}
      </article>`;
  };
  let mapHtml = '';
  if (visual) {
    // Annotate all: map open on top. Guided walk: the section comes first, the map folds below it.
    const mapOpen = mode === 'walk' ? ui.openMore.has('map:open') : !ui.openMore.has('map:closed');
    if (visuals?.map) mapHtml = `<details class="map-box" data-more="${mode === 'walk' ? 'map-walk' : 'map'}" ${mapOpen ? 'open' : ''}><summary>Chapter map</summary><div class="wb" id="wb-map"></div><p class="hint">Tap an idea to jump to it.</p></details>`;
    else if (doc?.visualError) mapHtml = `<p class="status error">Could not draw this chapter: ${esc(doc.visualError)} <button id="draw-again" class="link red">Try again</button></p>`;
    else if (!visuals && !doc?.visualBusy && !doc?.busy) mapHtml = '<p class="status">No pictures yet. <button id="draw-again" class="link red">Draw this chapter</button></p>';
  }
  const writing = partial ? skeleton(`Writing section ${a.sections.length + 1}.`) : '';
  if (mode === 'walk') {
    const last = cur === a.sections.length - 1;
    box.innerHTML = `
      <div class="walk-nav">
        <button id="w-back" class="link" ${cur === 0 ? 'disabled' : ''}>‹ Back</button>
        ${track(a.sections.map((x, k) => ({ done: k < cur, title: x.title })), cur)}
        <span class="count">${pad(cur + 1)} / ${pad(a.sections.length)}${partial ? '+' : ''}</span>
        ${last && partial ? '<button class="primary walk-next" disabled>Writing</button>' : last ? '<button id="w-finish" class="primary walk-next">Finish</button>' : '<button id="w-next" class="primary walk-next">Next</button>'}
      </div>
      ${card(a.sections[cur], cur)}
      ${mapHtml}`;
  } else {
    box.innerHTML = mapHtml + a.sections.map(card).join('') + writing;
  }
  if (visual && visuals) hydrateWhiteboards(src, chapter, visuals, cur);
}

// ---------- whiteboards ----------
const wbKey = (i) => `${ui.store.activeId}:${ui.doc?.chapter ?? active()?.chapter ?? 0}:${i}`;
const currentVisuals = () => ui.doc?.visuals || ui.cachedVisuals?.visuals || null;

function drawCard(i, { animate = false } = {}) {
  const v = currentVisuals()?.sections?.[i];
  const host = document.querySelector(`[data-wb="${i}"]`);
  if (!v || !host) return;
  const key = wbKey(i);
  const st = (ui.wb[key] ||= { step: v.steps.length - 1 });
  st.step = Math.max(0, Math.min(st.step, v.steps.length - 1));
  drawWhiteboard(host, layoutVisual(v), { step: st.step, animate, seedKey: key });
  const cap = document.querySelector(`[data-cap="${i}"]`);
  if (cap) cap.textContent = v.steps[st.step]?.caption || '';
  const dotsEl = document.querySelector(`[data-dots="${i}"]`);
  if (dotsEl) dotsEl.innerHTML = v.steps.map((_, k) => `<i class="${k <= st.step ? 'on' : ''}" data-wb-go="${i}:${k}" title="Step ${k + 1}"></i>`).join('');
  const playBtn = document.querySelector(`[data-wb-play="${i}"]`);
  if (playBtn) playBtn.textContent = ui.timer && ui.playing === key ? 'Pause' : st.step === v.steps.length - 1 ? 'Replay' : 'Play';
}

function stopPlay() {
  clearInterval(ui.timer);
  ui.timer = null;
  ui.playing = null;
}

function play(i, { fromStart = true } = {}) {
  const v = currentVisuals()?.sections?.[i];
  if (!v) return;
  stopPlay();
  const key = wbKey(i);
  const st = (ui.wb[key] ||= { step: 0 });
  if (fromStart || st.step >= v.steps.length - 1) st.step = 0;
  ui.playing = key;
  if (v.steps.length > 1) {
    ui.timer = setInterval(() => {
      st.step += 1;
      if (st.step >= v.steps.length - 1) stopPlay();
      drawCard(i, { animate: true });
    }, STEP_MS);
  }
  drawCard(i, { animate: true });
}

function setStep(i, step) {
  stopPlay();
  const key = wbKey(i);
  const prev = ui.wb[key]?.step ?? 0;
  (ui.wb[key] ||= {}).step = step;
  drawCard(i, { animate: step > prev });
}

function hydrateWhiteboards(src, chapter, visuals, cur) {
  const mapHost = $('wb-map');
  if (visuals.map && mapHost) {
    const key = `${src.id}:${chapter}:map`;
    drawWhiteboard(mapHost, layoutMap(visuals.map), { animate: ui.mapDrawn !== key, seedKey: key, current: cur });
    ui.mapDrawn = key;
  }
  for (const host of document.querySelectorAll('[data-wb]')) {
    const i = Number(host.dataset.wb);
    if (ui.playing !== wbKey(i)) drawCard(i);
  }
  // The section you are on draws itself in once, like a tutor at the board.
  const curKey = `${src.id}:${chapter}:${cur}`;
  if (visuals.sections?.[cur] && ui.autoKey !== curKey) {
    ui.autoKey = curKey;
    play(cur);
  } else if (ui.playing) {
    const i = Number(ui.playing.split(':').pop());
    drawCard(i);
  }
}

function renderBuild(a, ch) {
  const box = $('tab-build');
  if (!a) {
    box.innerHTML = '<div class="cta"><p class="q">Nothing to build yet.</p><h2>The build card appears once the chapter is explained.</h2></div>';
    return;
  }
  const b = a.buildCard;
  if (!b) {
    box.innerHTML = skeleton('The build card is written after the sections.');
    return;
  }
  box.innerHTML = `
    <div class="build">
      <p class="pill">Core idea</p><div class="core">${renderMarkdown(b.coreIdea)}</div>
      <p class="pill">Where it fits in a product</p><ul class="fits">${b.whereItFits.map((w) => `<li><span>${renderMarkdown(w).replace(/^<p>|<\/p>$/g, '')}</span></li>`).join('')}</ul>
      ${b.sketch ? `<p class="pill">Sketch · ${esc(b.sketchLang)}</p><pre><code>${esc(b.sketch)}</code></pre><div class="sketch-actions"><button id="step-sketch" class="link red">Step through it</button><button id="copy-sketch" class="link">Copy</button></div>` : ''}
      <p class="pill">In short</p><div class="summary">${renderMarkdown(a.summary)}</div>
      <div class="actions">
        <button id="export" class="primary">Export to Neurotree</button>
        <button id="toggle-done" class="link">${ch?.done ? 'Mark not done' : 'Mark chapter done'}</button>
        <div id="export-status" class="status"></div>
      </div>
    </div>`;
}

// ---------- code visualizer ----------
const LANGS = ['auto', 'python', 'typescript', 'javascript', 'sql', 'go', 'rust', 'java', 'c++', 'c#', 'bash', 'pseudocode'];

function renderCode(src, doc, analysis) {
  const box = $('tab-code');
  const c = ui.code;
  if (!c.pick) {
    const listings = doc?.listings;
    // Look for code in the chapter the first time the tab opens.
    if (doc && !listings && !doc.listingsBusy && !doc.listingsError && !c.asked?.has(`${src.id}:${doc.chapter}`)) {
      (c.asked ||= new Set()).add(`${src.id}:${doc.chapter}`);
      command({ cmd: 'listings' });
    }
    const fromChapter = !doc
      ? '<p class="status">Open the PDF to look for code in it.</p>'
      : doc.listingsBusy ? '<p class="status busy">Looking for code and pseudo-code in this chapter</p>'
      : doc.listingsError ? `<p class="status error">${esc(doc.listingsError)} <button id="find-code" class="link red">Try again</button></p>`
      : listings?.length ? `<ul class="code-pick">${listings.map((l, i) => `<li><button data-pick="listing:${i}"><span>${esc(l.title)}</span><span class="lang">${esc(l.language)} · p. ${l.page}</span></button></li>`).join('')}</ul>`
      : listings ? '<p class="status">No code in this chapter. Try the build card sketch or paste your own.</p>'
      : '<p class="status"><button id="find-code" class="link red">Find code in this chapter</button></p>';
    const sketch = analysis?.buildCard?.sketch
      ? `<ul class="code-pick"><li><button data-pick="sketch"><span>Build card sketch</span><span class="lang">${esc(analysis.buildCard.sketchLang)}</span></button></li></ul>`
      : '<p class="status">Explain the chapter to get a build card sketch.</p>';
    // Keep the paste box (and what is typed in it) when only the lists change.
    if ($('own-code') && $('code-chapter')) {
      $('code-chapter').innerHTML = fromChapter;
      $('code-sketch').innerHTML = sketch;
      return;
    }
    box.innerHTML = `
      <div class="code-intro"><p class="q">Any language, line by line.</p><h2>See what every line does and what every variable holds.</h2></div>
      <p class="pill">From this chapter</p><div id="code-chapter">${fromChapter}</div>
      <p class="pill">Build card</p><div id="code-sketch">${sketch}</div>
      <p class="pill">Your own code</p>
      <textarea id="own-code" placeholder="Paste any code: Python, TypeScript, SQL, Go, Rust, pseudo-code" spellcheck="false">${esc(c.own)}</textarea>
      <div class="own-row"><select id="own-lang">${LANGS.map((l) => `<option ${l === c.ownLang ? 'selected' : ''}>${l}</option>`).join('')}</select><button id="trace-own" class="primary">Visualize</button></div>`;
    return;
  }
  const head = `<div class="tv-head"><span class="tv-title">${esc(c.pick.title)}</span><button id="code-back" class="link">‹ All code</button></div>`;
  if (c.busy) {
    box.innerHTML = `${head}<p class="status busy">Claude is tracing it line by line. About 30–90 s.</p><pre class="tv-out">${esc(c.pick.code)}</pre>`;
    return;
  }
  if (c.error || !c.trace) {
    box.innerHTML = `${head}<p class="status error">${esc(c.error || 'No trace')} <button id="trace-retry" class="link red">Try again</button></p>`;
    return;
  }
  const t = c.trace;
  box.innerHTML = `${head}
    ${t.summary ? `<p class="tv-summary">${esc(t.summary)}</p>` : ''}
    <div class="tv-code" id="tv-code"></div>
    <div class="tv-explain" id="tv-explain"></div>
    <div class="tv-ctl">
      <button id="tv-prev" class="link" title="Previous step (←)">‹</button>
      <button id="tv-play" class="link">Play</button>
      <button id="tv-next" class="link" title="Next step (→)">›</button>
      <input id="tv-range" type="range" min="0" max="${t.steps.length - 1}" value="${c.step}">
      <span class="count" id="tv-count"></span>
    </div>
    <div id="tv-state"></div>
    ${t.added ? '<p class="status">Faded lines at the end were added as an example run.</p>' : ''}
    <button id="trace-retry" class="link">Trace again</button>`;
  drawTraceStep();
}

const EVENTS = { call: 'enter function', return: 'return', skip: 'fast-forward', error: 'error', line: '' };

function drawTraceStep() {
  const t = ui.code.trace;
  if (!t || !$('tv-code')) return;
  const i = (ui.code.step = Math.max(0, Math.min(ui.code.step, t.steps.length - 1)));
  const s = t.steps[i];
  $('tv-code').innerHTML = codeHtml(t, i);
  $('tv-explain').innerHTML = `${EVENTS[s.event] ? `<span class="ev">${EVENTS[s.event]}</span>` : ''}${esc(s.explain)}`;
  $('tv-state').innerHTML = stateHtml(t, i);
  $('tv-range').value = i;
  $('tv-count').textContent = `step ${i + 1}/${t.steps.length} · line ${s.line}`;
  $('tv-play').textContent = ui.code.timer ? 'Pause' : i === t.steps.length - 1 ? 'Replay' : 'Play';
  const cur = $('tv-code').querySelector('.ln.cur');
  if (cur) {
    const box = $('tv-code');
    const top = cur.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  }
}

function traceStep(delta) {
  stopTracePlay();
  ui.code.step += delta;
  drawTraceStep();
}

function stopTracePlay() {
  clearInterval(ui.code.timer);
  ui.code.timer = null;
}

function toggleTracePlay() {
  const t = ui.code.trace;
  if (!t) return;
  if (ui.code.timer) {
    stopTracePlay();
    return drawTraceStep();
  }
  if (ui.code.step >= t.steps.length - 1) ui.code.step = 0;
  ui.code.timer = setInterval(() => {
    ui.code.step += 1;
    if (ui.code.step >= t.steps.length - 1) stopTracePlay();
    drawTraceStep();
  }, TRACE_MS);
  drawTraceStep();
}

async function runTrace(pick, { force = false } = {}) {
  stopTracePlay();
  Object.assign(ui.code, { pick, trace: null, busy: true, error: '', step: 0 });
  ui.tab = 'code';
  render();
  const src = active();
  const ch = src?.chapters?.[ui.doc?.chapter ?? src.chapter];
  try {
    const res = await bridge.trace({
      code: pick.code, language: pick.language, title: pick.title, force,
      context: src ? `"${src.title}"${ch ? `, chapter "${ch.title}"` : ''}` : '', aboutMe: ui.store.aboutMe,
    });
    if (ui.code.pick !== pick) return;
    ui.code.trace = res;
  } catch (e) {
    if (ui.code.pick === pick) ui.code.error = e.message;
  } finally {
    if (ui.code.pick === pick) {
      ui.code.busy = false;
      render();
    }
  }
}

function renderGlossary(a) {
  const filter = $('gloss-filter').value.trim().toLowerCase();
  const all = Object.values(ui.store.glossary).sort((x, y) => x.term.localeCompare(y.term));
  const hits = filter ? all.filter((g) => (g.term + ' ' + g.definition).toLowerCase().includes(filter)) : all;
  const dl = (items, src) => `<dl>${items.map((g) => `<dt>${esc(g.term)}</dt><dd>${esc(g.definition)}${src && g.sources ? ` <span class="src">· ${esc(g.sources.join(', '))}</span>` : ''}</dd>`).join('')}</dl>`;
  $('gloss-list').innerHTML =
    (a && !filter ? `<p class="pill">This chapter · ${a.glossary.length}</p>${dl(a.glossary, false)}` : '') +
    `<p class="pill">${filter ? 'Matches' : 'Everything you have read'} · ${hits.length}</p>${dl(hits, true)}`;
}

function renderLibrary() {
  $('sources').innerHTML = ui.store.sources.map((s) => {
    const p = progress(s);
    return `<li data-src="${s.id}" class="${s.id === ui.store.activeId ? 'on' : ''}">
      <div class="s-row"><span class="s-title">${esc(s.title)}</span>
        <span><span class="s-pct">${p.total ? `${p.pct}%` : '…'}</span>
        <button class="rm" data-rm="${s.id}" title="Remove">${ui.removing === s.id ? 'sure?' : 'remove'}</button></span></div>
      <div class="mini">${(s.chapters || []).map((c) => `<span class="${c.done ? 'done' : ''}"></span>`).join('')}</div>
    </li>`;
  }).join('');
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}
function libStatus(text, kind = '') {
  $('lib-status').textContent = text;
  $('lib-status').className = `status ${kind}`;
}

// ---------- data ----------
async function refreshStore() {
  ui.store = await getState();
  const src = active();
  if (src && !(ui.doc?.sourceId === src.id)) {
    const key = `${src.id}:${src.chapter || 0}`;
    if (ui.cachedAnalysis?.key !== key) ui.cachedAnalysis = { key, analysis: await getAnalysis(src.id, src.chapter || 0) };
    if (ui.cachedVisuals?.key !== key) ui.cachedVisuals = { key, visuals: await getVisuals(src.id, src.chapter || 0) };
  }
  render();
}

async function checkBridge() {
  const ok = await bridge.health();
  $('bridge').className = `bridge ${ok ? 'on' : 'off'}`;
  $('bridge').title = ok ? 'Bridge on: Claude is reachable' : 'Bridge off';
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
      // The progress strip shows busy states; only errors need words here.
      setStatus(m.kind === 'error' ? m.text : '', m.kind);
      break;
    case 'focus':
      if (ui.doc) ui.doc.section = m.section;
      render();
      document.querySelector('.sec.on')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  if (ui.menuOpen && !t.closest('#menu-btn')) {
    ui.menuOpen = false;
    $('menu').hidden = true;
  }
  const chLi = t.closest('#chapters li');
  if (chLi) {
    ui.chaptersOpen = false;
    render();
    return command({ cmd: 'open', chapter: Number(chLi.dataset.ch) });
  }
  const pageChip = t.closest('[data-page-sec]');
  if (pageChip) {
    e.stopPropagation();
    return gotoSection(Number(pageChip.dataset.pageSec));
  }

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
    ui.drawerOpen = false;
    render();
    return openViewer(srcLi.dataset.src);
  }

  const modeBtn = t.closest('[data-mode]');
  if (modeBtn) {
    if (ui.doc) ui.doc.mode = modeBtn.dataset.mode;
    render();
    return command({ cmd: 'mode', mode: modeBtn.dataset.mode });
  }
  const viewBtn = t.closest('[data-view]');
  if (viewBtn) {
    const view = viewBtn.dataset.view;
    ui.store.view = view;
    stopPlay();
    ui.autoKey = null;
    await setState({ view });
    if (view === 'visual' && ui.doc?.analysis && !ui.doc.visuals && !ui.doc.visualBusy) command({ cmd: 'visualize' });
    return render();
  }
  const wb = t.closest('[data-wb-prev], [data-wb-next], [data-wb-play], [data-wb-go]');
  if (wb) {
    e.stopPropagation();
    const d = wb.dataset;
    if (d.wbGo) {
      const [i, k] = d.wbGo.split(':').map(Number);
      return setStep(i, k);
    }
    const i = Number(d.wbPrev ?? d.wbNext ?? d.wbPlay);
    const v = currentVisuals()?.sections?.[i];
    const step = ui.wb[wbKey(i)]?.step ?? (v ? v.steps.length - 1 : 0);
    if (d.wbPlay !== undefined) {
      if (ui.timer && ui.playing === wbKey(i)) {
        stopPlay();
        return drawCard(i);
      }
      return play(i, { fromStart: step >= (v?.steps.length || 1) - 1 });
    }
    if (d.wbPrev !== undefined) return setStep(i, Math.max(0, step - 1));
    return setStep(i, Math.min((v?.steps.length || 1) - 1, step + 1));
  }
  const node = t.closest('.wb-node');
  if (node) return gotoSection(Number(node.dataset.section));
  if (t.closest('details.more, details.map-box')) return;
  const tabBtn = t.closest('.tabs button');
  if (tabBtn) {
    ui.tab = tabBtn.dataset.tab;
    return render();
  }
  const cardEl = t.closest('.sec[data-section]');
  if (cardEl && !t.closest('form') && !t.closest('a')) {
    const si = Number(cardEl.dataset.section);
    if (si !== (ui.doc?.section ?? -1)) gotoSection(si);
    return;
  }

  const pickBtn = t.closest('[data-pick]');
  if (pickBtn) {
    const [kind, idx] = pickBtn.dataset.pick.split(':');
    const a = ui.doc?.analysis || ui.cachedAnalysis?.analysis;
    if (kind === 'sketch' && a) return runTrace({ title: 'Build card sketch', code: a.buildCard.sketch, language: a.buildCard.sketchLang });
    const l = ui.doc?.listings?.[Number(idx)];
    if (l) return runTrace({ title: l.title, code: l.code, language: l.language });
    return;
  }
  switch (t.closest('button')?.id || t.id) {
    case 'step-sketch': {
      const a = ui.doc?.analysis || ui.cachedAnalysis?.analysis;
      if (a?.buildCard.sketch) runTrace({ title: 'Build card sketch', code: a.buildCard.sketch, language: a.buildCard.sketchLang });
      return;
    }
    case 'find-code':
      return command({ cmd: 'listings', force: true });
    case 'trace-own': {
      const code = $('own-code').value;
      if (!code.trim()) return;
      ui.code.own = code;
      ui.code.ownLang = $('own-lang').value;
      return runTrace({ title: 'Your code', code, language: ui.code.ownLang === 'auto' ? '' : ui.code.ownLang });
    }
    case 'trace-retry':
      return ui.code.pick && runTrace(ui.code.pick, { force: !!ui.code.trace });
    case 'code-back':
      stopTracePlay();
      ui.code.pick = null;
      return render();
    case 'tv-prev':
      return traceStep(-1);
    case 'tv-next':
      return traceStep(1);
    case 'tv-play':
      return toggleTracePlay();
    case 'draw-again':
    case 'redraw':
      return command({ cmd: 'visualize', force: true });
    case 'explain-cta':
    case 'explain':
      return command({ cmd: 'explain', force: $('explain').textContent.startsWith('Re-') });
    case 'menu-btn':
      ui.menuOpen = !ui.menuOpen;
      $('menu').hidden = !ui.menuOpen;
      return;
    case 'chapter-btn':
      ui.chaptersOpen = !ui.chaptersOpen;
      return render();
    case 'lib-btn':
    case 'welcome-add':
      ui.drawerOpen = true;
      render();
      if (t.closest('#welcome-add')) $('file').click();
      return;
    case 'drawer-close':
    case 'scrim':
      ui.drawerOpen = false;
      return render();
    case 'open-settings':
      ui.drawerOpen = true;
      render();
      $('settings').open = true;
      $('about').focus();
      return;
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
        libStatus('Downloading PDF…', 'busy');
        await importFromUrl(ui.thisTabUrl);
        libStatus('');
        ui.drawerOpen = false;
        render();
      } catch (err) {
        libStatus(err.message + (ui.thisTabUrl.startsWith('file:') ? ' (turn on "Allow access to file URLs" for the extension, or use + Add PDF)' : ''), 'error');
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
      libStatus('Downloading PDF…', 'busy');
      await importFromUrl(url);
      $('url').value = '';
      libStatus('');
      ui.drawerOpen = false;
      render();
    } catch (err) {
      libStatus(err.message, 'error');
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
  if (file) {
    await importFromFile(file);
    ui.drawerOpen = false;
    render();
  }
  e.target.value = '';
});
document.addEventListener('toggle', (e) => {
  const k = e.target.dataset?.more;
  if (!k) return;
  const key = k === 'map' ? 'map:closed' : k === 'map-walk' ? 'map:open' : k;
  const on = k === 'map' ? !e.target.open : e.target.open;
  if (on) ui.openMore.add(key);
  else ui.openMore.delete(key);
}, true);
document.addEventListener('input', (e) => {
  if (e.target.id === 'tv-range') {
    stopTracePlay();
    ui.code.step = Number(e.target.value);
    drawTraceStep();
  } else if (e.target.id === 'own-code') ui.code.own = e.target.value;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (ui.drawerOpen || ui.menuOpen || ui.chaptersOpen)) {
    ui.drawerOpen = ui.menuOpen = ui.chaptersOpen = false;
    return render();
  }
  if (ui.tab !== 'code' || !ui.code.trace || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight') traceStep(1);
  else if (e.key === 'ArrowLeft') traceStep(-1);
  else if (e.key === ' ') {
    e.preventDefault();
    toggleTracePlay();
  } else return;
  e.preventDefault();
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
