// Code visualizer: Claude traces code like a debugger (any language) and returns
// each step as data: the line that runs, a plain-words explanation, every
// variable in scope (values, lists, matrices, dicts, tables) and the output so far.
// Also finds the code / pseudo-code listings in a chapter.

export const TRACE_VERSION = 1;
export const VALUE_KINDS = ['value', 'list', 'matrix', 'dict', 'object', 'table'];

const variable = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'name', 'kind', 'text', 'cells'],
  properties: {
    scope: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: VALUE_KINDS },
    text: { type: 'string' },
    cells: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
  },
};

export const TRACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'summary', 'lines', 'added', 'steps'],
  properties: {
    language: { type: 'string' },
    summary: { type: 'string' },
    lines: { type: 'array', items: { type: 'string' } },
    added: { type: 'integer' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'event', 'explain', 'vars', 'output'],
        properties: {
          line: { type: 'integer' },
          event: { type: 'string', enum: ['line', 'call', 'return', 'skip', 'error'] },
          explain: { type: 'string' },
          vars: { type: 'array', items: variable },
          output: { type: 'string' },
        },
      },
    },
  },
};

export const LISTINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['listings'],
  properties: {
    listings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'language', 'page', 'code'],
        properties: { title: { type: 'string' }, language: { type: 'string' }, page: { type: 'integer' }, code: { type: 'string' } },
      },
    },
  },
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const MAX_STEPS = 80;

export function validateTrace(raw, code) {
  if (!raw || !Array.isArray(raw.steps)) throw new Error('trace has no steps');
  let lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l) => str(l, 300).replace(/\s+$/, '')).slice(0, 200);
  const original = String(code || '').replace(/\s+$/, '').split('\n');
  // Claude may only append example lines; the reader's own code is shown as given.
  const added = Math.max(0, Math.min(12, Number.isInteger(raw.added) ? raw.added : 0, lines.length - original.length));
  lines = [...original, ...lines.slice(lines.length - added)].slice(0, 220);
  const steps = raw.steps
    .map((s) => ({
      line: Number.isInteger(s.line) ? Math.min(lines.length, Math.max(1, s.line)) : 1,
      event: ['line', 'call', 'return', 'skip', 'error'].includes(s.event) ? s.event : 'line',
      explain: str(s.explain, 240).trim(),
      vars: (Array.isArray(s.vars) ? s.vars : []).slice(0, 16).map((v) => ({
        scope: str(v.scope, 40).trim() || 'global',
        name: str(v.name, 40).trim(),
        kind: VALUE_KINDS.includes(v.kind) ? v.kind : 'value',
        text: str(v.text, 80),
        cells: (Array.isArray(v.cells) ? v.cells : []).slice(0, 8).map((r) => (Array.isArray(r) ? r : []).slice(0, 8).map((c) => str(String(c ?? ''), 24))),
      })).filter((v) => v.name),
      output: str(s.output, 2000),
    }))
    .slice(0, MAX_STEPS);
  if (!steps.length) throw new Error('trace has no steps');
  return { language: str(raw.language, 30).trim() || 'code', summary: str(raw.summary, 400).trim(), lines, added, steps };
}

export function validateListings(raw, [first, last]) {
  const out = (Array.isArray(raw?.listings) ? raw.listings : [])
    .map((l) => ({
      title: str(l.title, 80).trim() || 'Listing',
      language: str(l.language, 30).trim() || 'pseudocode',
      page: Number.isInteger(l.page) ? Math.min(last, Math.max(first, l.page)) : first,
      code: str(l.code, 6000).replace(/\s+$/, ''),
    }))
    .filter((l) => l.code.split('\n').length >= 2)
    .slice(0, 6);
  return { listings: out };
}

export function tracePrompt({ aboutMe, code, language, title, context }) {
  const numbered = String(code).replace(/\s+$/, '').split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
  return `Reader: ${aboutMe}
${context ? `\nThey are reading: ${context}\n` : ''}
Trace this ${language && language !== 'auto' ? language : ''} code${title ? ` ("${title}")` : ''} step by step, like a visual debugger (think Python Tutor) with a patient tutor narrating each step.

<code>
${numbered}
</code>

Return JSON matching the schema:
- language: the language you see ("python", "typescript", "sql", "go", "pseudocode"...).
- summary: what the code does, in at most 2 plain sentences.
- lines: the code, one string per line, exactly as given (without the "NN| " prefix). If the code only defines functions or classes and never calls them, or reads input it does not have, append at most 8 lines with a small, realistic example call or input so there is something to run; added = how many lines you appended (else 0).
- steps: the execution in order, 8 to 60 steps. For each step:
  - line: the 1-based line number that runs at this step (in lines).
  - event: "call" when entering a function, "return" when leaving one, "line" otherwise, "skip" for a summary step that fast-forwards repeated loop rounds, "error" if this line would fail.
  - explain: at most 22 words, plain language: what this line does right now with these values and why it matters. Define jargon. Do not just restate the code.
  - vars: EVERY variable visible at this step, after the line runs, innermost scope last. scope = "global" or the function name with "()" (e.g. "attention()"). kind and cells:
    - value: numbers, strings, booleans, None. text = the value as the language prints it. cells = [].
    - list: arrays, lists, tuples, sets. text = short form like "[3, 1, 2]". cells = one row of item strings (max 8; "…" for the rest).
    - matrix: 2D arrays, tensors, numpy arrays. text = shape and dtype, e.g. "2×3 float". cells = rows of numbers (max 8×8, round to 2 decimals). Bigger tensors: show a corner and say so in text.
    - dict: maps, objects as key/values, JSON. text = short form. cells = rows of [key, value].
    - object: class instances. text = the class name. cells = rows of [field, value].
    - table: SQL tables or intermediate results. text = "N rows". cells = header row then up to 6 rows.
  - output: everything printed so far (cumulative), "" if nothing.
- Keep it short and true: trace loops fully for the first 2 rounds, then add one "skip" step that jumps to the state after the last round. Use small example inputs so values fit in a box. For SQL, step through the query in execution order (FROM, JOIN, WHERE, GROUP BY, SELECT, ORDER BY), line = the clause, and show the intermediate table as a variable. For code that needs a GPU, a library or a database, simulate it with tiny inputs. Values must be what the code would really produce. No em dashes.`;
}

export function listingsPrompt({ text, pageRange }) {
  return `Below is a chapter of a technical text (pages ${pageRange[0]}-${pageRange[1]}, page breaks marked [[p N]]).

<chapter>
${text}
</chapter>

Find the code in it: code listings, pseudo-code, algorithm boxes, SQL queries, shell commands of 2+ lines, and equations written as step-by-step procedures. Return JSON matching the schema, at most 6, in reading order:
- title: short name ("Algorithm 1: Adam", "Listing 3.2: word count").
- language: "python", "sql", "pseudocode" etc.
- page: the page it is on.
- code: the code as written, one statement per line, with indentation restored where the PDF lost it. Fix only line breaks and spacing that PDF extraction broke; never change the logic.
If there is no code at all, return an empty list.`;
}
