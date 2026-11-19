import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTrace, validateListings, tracePrompt } from '../bridge/trace.mjs';
import { highlight, changedVars, scopes, codeHtml, stateHtml } from '../extension/shared/trace-view.js';

const code = 'def f(x):\n    return x * 2\n';
const raw = {
  language: 'python', summary: 'Doubles.', added: 1,
  lines: ['def f(x):', '    return x * 2', 'print(f(3))'],
  steps: [
    { line: 3, event: 'line', explain: 'Call f with 3.', vars: [], output: '' },
    { line: 1, event: 'call', explain: 'Enter f.', vars: [{ scope: 'f()', name: 'x', kind: 'value', text: '3', cells: [] }], output: '' },
    { line: 99, event: 'weird', explain: 'Return 6.', vars: [{ scope: 'f()', name: 'x', kind: 'nope', text: '3', cells: [] }, { scope: '', name: '', kind: 'value', text: '', cells: [] }], output: '6\n' },
  ],
};

test('validateTrace keeps the reader code verbatim, clamps lines and kinds', () => {
  const t = validateTrace({ ...raw, lines: ['def f(x):', '    return x*2  # changed', 'print(f(3))'] }, code);
  assert.deepEqual(t.lines, ['def f(x):', '    return x * 2', 'print(f(3))']);
  assert.equal(t.added, 1);
  assert.equal(t.steps[2].line, 3);
  assert.equal(t.steps[2].event, 'line');
  assert.equal(t.steps[2].vars.length, 1);
  assert.equal(t.steps[2].vars[0].kind, 'value');
});

test('validateTrace refuses empty traces and caps appended lines', () => {
  assert.throws(() => validateTrace({ steps: [] }, code));
  const t = validateTrace({ ...raw, added: 50 }, code);
  assert.equal(t.added, 1);
});

test('validateListings drops one-liners and clamps pages', () => {
  const l = validateListings({ listings: [{ title: 'A', language: 'python', page: 99, code: 'a = 1\nb = 2' }, { title: 'B', language: 'sql', page: 1, code: 'SELECT 1' }] }, [3, 7]);
  assert.equal(l.listings.length, 1);
  assert.equal(l.listings[0].page, 7);
});

test('tracePrompt numbers lines', () => {
  assert.match(tracePrompt({ aboutMe: 'me', code, language: 'python' }), /  1\| def f\(x\):\n  2\|     return x \* 2/);
});

test('highlight escapes HTML and marks tokens', () => {
  const h = highlight('if x < 3: print("a<b")  # hi', 'python');
  assert.match(h, /<span class="tk-k">if<\/span>/);
  assert.match(h, /&lt; <span class="tk-n">3<\/span>/);
  assert.match(h, /<span class="tk-s">&quot;a&lt;b&quot;<\/span>/);
  assert.match(h, /<span class="tk-c"># hi<\/span>/);
  assert.match(highlight('SELECT name FROM users -- all', 'sql'), /tk-k">SELECT.*tk-c">-- all/);
  assert.doesNotMatch(highlight('<img src=x onerror=alert(1)>', 'js'), /<img/);
});

test('changedVars and scopes', () => {
  const a = [{ scope: 'global', name: 'x', kind: 'value', text: '1', cells: [] }];
  const b = [{ scope: 'global', name: 'x', kind: 'value', text: '2', cells: [] }, { scope: 'f()', name: 'y', kind: 'value', text: '0', cells: [] }];
  assert.deepEqual([...changedVars(a, b)].length, 2);
  assert.equal(changedVars(b, b).size, 0);
  assert.deepEqual(scopes([b[1], b[0]]).map((s) => s[0]), ['global', 'f()']);
});

test('codeHtml marks the running and previous line; stateHtml draws values', () => {
  const t = validateTrace(raw, code);
  const html = codeHtml(t, 1);
  assert.match(html, /class="ln cur call" data-ln="1"/);
  assert.match(html, /class="ln prev added" data-ln="3"/);
  const st = stateHtml({ steps: [{ vars: [{ scope: 'global', name: 'xs', kind: 'list', text: '[1, 2]', cells: [['1', '2']] }, { scope: 'global', name: 'm', kind: 'matrix', text: '2×2', cells: [['1', '0'], ['0', '1']] }], output: 'hi' }] }, 0);
  assert.match(st, /tv-list/);
  assert.match(st, /tv-grid/);
  assert.match(st, /tv-out">hi/);
});
