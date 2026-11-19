// Code visualizer views: turns one step of a trace (bridge/trace.mjs) into HTML:
// highlighted code with the running line marked, the tutor's words, every
// variable drawn by kind (value, list boxes, matrix grid, dict/table rows) grouped
// by scope, and the output so far. Pure string building, unit-tested in Node.
import { escapeHtml as esc } from './md.js';

const KEYWORDS = new Set(`
and as assert async await break case catch class const continue def default del delete do elif else enum except export extends
false finally fn for from func function go if impl import in interface is lambda let loop match mut new nil none not null of or
package pass pub raise return self static struct super switch this throw true try type typeof use val var void while with yield
select from where group by order having join left right inner outer on limit insert into update set values create table as distinct
count sum avg min max union all case when then end and or not null is like between exists`.split(/\s+/).filter(Boolean));

const HASH_COMMENT = /^(python|py|ruby|rb|shell|sh|bash|r|yaml|perl|pseudocode)$/i;

// Highlights one line of code; language-agnostic with a few comment styles.
export function highlight(line, language = '') {
  const lang = language.toLowerCase();
  const comment = lang === 'sql' ? /--.*$/ : HASH_COMMENT.test(lang) ? /#.*$/ : /\/\/.*$/;
  const re = new RegExp(`(${comment.source})|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`[^\`]*\`)|(\\b\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?\\b)|([A-Za-z_][\\w]*)`, 'gi');
  let out = '';
  let last = 0;
  for (const m of line.matchAll(re)) {
    out += esc(line.slice(last, m.index));
    const [tok, c, s, n, w] = m;
    if (c) out += `<span class="tk-c">${esc(tok)}</span>`;
    else if (s) out += `<span class="tk-s">${esc(tok)}</span>`;
    else if (n) out += `<span class="tk-n">${esc(tok)}</span>`;
    else if (w && KEYWORDS.has(w.toLowerCase()) && (lang === 'sql' || w === w.toLowerCase() || /^(True|False|None)$/.test(w))) out += `<span class="tk-k">${esc(tok)}</span>`;
    else if (w && line[m.index + tok.length] === '(') out += `<span class="tk-f">${esc(tok)}</span>`;
    else out += esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(line.slice(last));
}

const varKey = (v) => `${v.scope}\u0000${v.name}`;
const varSig = (v) => `${v.kind}|${v.text}|${JSON.stringify(v.cells)}`;

// Names of variables that are new or changed since the previous step.
export function changedVars(prev, cur) {
  const before = new Map((prev || []).map((v) => [varKey(v), varSig(v)]));
  return new Set(cur.filter((v) => before.get(varKey(v)) !== varSig(v)).map(varKey));
}

// Groups variables by scope, keeping the order they first appear (global first).
export function scopes(vars) {
  const out = new Map();
  for (const v of vars) {
    if (!out.has(v.scope)) out.set(v.scope, []);
    out.get(v.scope).push(v);
  }
  const list = [...out.entries()];
  list.sort((a, b) => (a[0] === 'global' ? -1 : b[0] === 'global' ? 1 : 0));
  return list;
}

function valueHtml(v) {
  const rows = v.cells || [];
  switch (v.kind) {
    case 'list':
      if (!rows[0]?.length) break;
      return `<div class="tv-list">${rows[0].map((c, i) => `<span class="cell"><i>${i}</i>${esc(c)}</span>`).join('')}</div>`;
    case 'matrix':
      if (!rows.length) break;
      return `<table class="tv-grid">${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
    case 'dict':
    case 'object':
      if (!rows.length) break;
      return `<table class="tv-kv">${rows.map((r) => `<tr><th>${esc(r[0] ?? '')}</th><td>${esc(r.slice(1).join(', '))}</td></tr>`).join('')}</table>`;
    case 'table':
      if (!rows.length) break;
      return `<table class="tv-table"><tr>${rows[0].map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  }
  return '';
}

export function codeHtml(trace, i) {
  const step = trace.steps[i];
  const prevLine = i > 0 ? trace.steps[i - 1].line : 0;
  const firstAdded = trace.lines.length - trace.added + 1;
  return trace.lines.map((l, k) => {
    const n = k + 1;
    const cls = [n === step.line ? `cur ${step.event}` : '', n === prevLine && n !== step.line ? 'prev' : '', trace.added && n >= firstAdded ? 'added' : ''].filter(Boolean).join(' ');
    const mark = n === step.line ? (step.event === 'error' ? '✗' : '➜') : n === prevLine ? '·' : '';
    return `<div class="ln ${cls}" data-ln="${n}"><span class="no">${n}</span><span class="mk">${mark}</span><code>${highlight(l, trace.language) || ' '}</code></div>`;
  }).join('');
}

export function stateHtml(trace, i) {
  const step = trace.steps[i];
  const changed = changedVars(i > 0 ? trace.steps[i - 1].vars : [], step.vars);
  const frames = scopes(step.vars).map(([scope, vars]) => `
    <div class="tv-frame"><div class="tv-scope">${esc(scope)}</div>
      ${vars.map((v) => {
        const isNew = changed.has(varKey(v));
        return `<div class="tv-var ${isNew ? 'new' : ''}"><div class="tv-row"><span class="tv-name">${esc(v.name)}</span><span class="tv-text">${esc(v.text)}</span>${isNew ? '<span class="tv-badge">new</span>' : ''}</div>${valueHtml(v)}</div>`;
      }).join('')}
    </div>`).join('');
  return `${frames || '<div class="tv-empty">No variables yet.</div>'}
    ${step.output ? `<div class="tv-out-h">Output</div><pre class="tv-out">${esc(step.output)}</pre>` : ''}`;
}
