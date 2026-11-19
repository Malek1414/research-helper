import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, isPrivateAddress } from '../bridge/server.mjs';
import { validateAnalysis } from '../bridge/schema.mjs';
import { chapterMarkdown, slug } from '../bridge/export.mjs';
import { claudeArgs } from '../bridge/claude.mjs';

const RAW = {
  summary: 'It sets up attention.',
  sections: [
    { title: 'Attention', page: 99, difficulty: 9, explanation: 'Attention picks what matters.',
      anchors: [{ page: 3, quote: 'attention is all you need here' }, { page: 3, quote: 'too short' }],
      note: '= weighted lookup over words' },
    { title: 'Easy', page: 2, difficulty: 1, explanation: 'Simple.', anchors: [], note: 'should be dropped' },
    { title: 'Empty', page: 2, difficulty: 2, explanation: '  ', anchors: [], note: '' },
  ],
  glossary: [{ term: 'Token', definition: 'A piece of text.' }, { term: '', definition: 'x' }],
  buildCard: { coreIdea: 'Weight inputs by relevance.', whereItFits: ['search'], sketch: 'x = 1\n', sketchLang: 'python' },
};

test('validateAnalysis clamps pages and difficulty, drops weak parts', () => {
  const a = validateAnalysis(RAW, [2, 5]);
  assert.equal(a.sections.length, 2);
  assert.equal(a.sections[0].page, 5);
  assert.equal(a.sections[0].difficulty, 5);
  assert.equal(a.sections[0].anchors.length, 1);
  assert.equal(a.sections[1].note, '');
  assert.equal(a.glossary.length, 1);
  assert.equal(a.buildCard.sketch, 'x = 1');
  assert.throws(() => validateAnalysis({ sections: [] }, [1, 1]));
});

test('export markdown has build card, walkthrough and glossary', () => {
  const md = chapterMarkdown({
    source: { title: 'Paper' }, chapterIndex: 0, chapter: { title: 'Intro', start: 1, end: 4 },
    analysis: validateAnalysis(RAW, [2, 5]), date: '2026-11-19',
  });
  assert.match(md, /^# Intro/);
  assert.match(md, /\*\*Core idea\.\*\* Weight inputs/);
  assert.match(md, /```python\nx = 1\n```/);
  assert.match(md, /difficulty ●●●●●/);
  assert.match(md, /> attention is all you need here \(p\. 3\)/);
  assert.match(md, /- \*\*Token\*\*: A piece of text\./);
  assert.equal(slug('Designing Data-Intensive Apps!'), 'designing-data-intensive-apps');
});

test('claude args disable tools, MCP and settings', () => {
  const args = claudeArgs({ schema: { type: 'object' }, model: 'sonnet' });
  for (const flag of ['-p', '--strict-mcp-config', '--no-session-persistence', '--json-schema']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
});

async function withBridge(fn, opts = {}) {
  let calls = 0;
  const dir = mkdtempSync(join(tmpdir(), 'rh-test-'));
  const server = createBridge({
    run: async ({ schema }) => { calls++; await new Promise((r) => setTimeout(r, 30)); return schema ? RAW : 'An answer.'; },
    cacheDir: join(dir, 'cache'), libraryDir: join(dir, 'library'), log: () => {}, ...opts,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, dir, calls: () => calls });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const post = (url, body, origin = 'chrome-extension://abc') =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });

test('bridge analyzes once, dedupes in-flight jobs and caches', async () => {
  await withBridge(async ({ base, calls }) => {
    const body = { sourceTitle: 'P', chapterTitle: 'C', pageRange: [2, 5], text: '[[p 2]] hello' };
    const [r1, r2] = await Promise.all([post(`${base}/analyze`, body), post(`${base}/analyze`, body)]);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
    assert.equal((await r1.json()).sections.length, 2);
    await r2.json();
    const r3 = await (await post(`${base}/analyze`, body)).json();
    assert.equal(r3.cached, true);
    assert.equal(calls(), 1);
  });
});

test('bridge rejects web origins and bad requests, answers questions, exports', async () => {
  await withBridge(async ({ base, dir }) => {
    assert.equal((await post(`${base}/ask`, { question: 'q' }, 'https://evil.example')).status, 403);
    assert.equal((await post(`${base}/analyze`, {})).status, 400);
    assert.equal((await (await post(`${base}/ask`, { question: 'why?' })).json()).answer, 'An answer.');
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    const out = await (await post(`${base}/export`, {
      source: { title: 'My Paper' }, chapterIndex: 1, chapter: { title: 'Method', start: 2, end: 4 },
      analysis: validateAnalysis(RAW, [3, 5]),
      glossary: { token: { term: 'Token', definition: 'A piece.', sources: ['My Paper'] } },
    })).json();
    assert.equal(out.file, join(dir, 'library', 'my-paper', '02-method.md'));
    assert.match(readFileSync(out.glossary, 'utf8'), /\*\*Token\*\*: A piece\. _\(My Paper\)_/);
  });
});

import { request, createServer } from 'node:http';

function raw(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('bridge serves the web app and blocks traversal, foreign hosts and foreign origins', async () => {
  await withBridge(async ({ base }) => {
    const port = Number(new URL(base).port);
    const home = await raw(port, '/');
    assert.equal(home.status, 200);
    assert.match(home.type, /text\/html/);
    assert.match(home.body, /web\/app\.js/);
    assert.match((await raw(port, '/extension/shared/platform.js')).type, /javascript/);
    assert.equal((await raw(port, '/extension/%2e%2e/bridge/server.mjs')).status, 404);
    assert.equal((await raw(port, '/bridge/server.mjs')).status, 404);
    assert.equal((await raw(port, '/', { host: 'evil.example' })).status, 403);
    assert.equal((await raw(port, '/health', { origin: 'https://evil.example' })).status, 403);
    const own = await fetch(`${base}/health`, { headers: { origin: base } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('access-control-allow-origin'), null);
  });
});

test('bridge proxies PDFs for the web app and refuses non-PDFs', async () => {
  const files = createServer((req, res) => res.end(req.url === '/a.pdf' ? '%PDF-1.7 fake' : '<html>nope</html>'));
  await new Promise((r) => files.listen(0, '127.0.0.1', r));
  const src = `http://127.0.0.1:${files.address().port}`;
  try {
    await withBridge(async ({ base }) => {
      const ok = await fetch(`${base}/fetch?url=${encodeURIComponent(`${src}/a.pdf`)}`);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'application/pdf');
      assert.equal(await ok.text(), '%PDF-1.7 fake');
      assert.equal((await fetch(`${base}/fetch?url=${encodeURIComponent(`${src}/page`)}`)).status, 415);
      assert.equal((await fetch(`${base}/fetch?url=file:///etc/passwd`)).status, 400);
    }, { allowPrivateFetch: true });
  } finally {
    files.closeAllConnections();
    files.close();
  }
});

test('pdf proxy refuses local and private addresses by default', async () => {
  await withBridge(async ({ base }) => {
    for (const u of ['http://127.0.0.1:22/x.pdf', 'http://localhost/x.pdf', 'http://192.168.18.199/x.pdf', 'http://[::1]/x.pdf', 'http://169.254.169.254/latest']) {
      assert.equal((await fetch(`${base}/fetch?url=${encodeURIComponent(u)}`)).status, 403, u);
    }
  });
  for (const a of ['10.0.0.1', '172.20.1.1', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '0.0.0.0']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['151.101.1.1', '8.8.8.8', '2606:4700::1111', '172.32.0.1']) assert.ok(!isPrivateAddress(a), a);
});

test('completeItems returns only the finished items of a half-written array', async () => {
  const { completeItems } = await import('../bridge/partial.mjs');
  const full = JSON.stringify({ summary: 'a "q" {x}', sections: [{ t: 'one ]}' }, { t: 'two', n: [1, 2] }, { t: 'three' }] });
  const cut = full.slice(0, full.indexOf('three') - 3);
  assert.deepEqual(completeItems(cut, 'sections'), [{ t: 'one ]}' }, { t: 'two', n: [1, 2] }]);
  assert.equal(completeItems(full, 'sections').length, 3);
  assert.deepEqual(completeItems('{"sum', 'sections'), []);
});

test('explain streams partial sections, draws visuals in parallel batches and caches both', async () => {
  const SECTIONS = Array.from({ length: 5 }, (_, i) => ({ title: `S${i}`, page: 2, difficulty: 2, explanation: `Explains ${i}.`, anchors: [], note: '' }));
  const FULL = { ...RAW, sections: SECTIONS };
  const visualFor = (i) => ({ section: i, kind: 'flow', oneLiner: 'x', groups: [], items: [{ id: 'a', label: 'A', detail: '', icon: '', group: '', value: 0 }, { id: 'b', label: 'B', detail: '', icon: '', group: '', value: 0 }], links: [], steps: [{ show: ['a', 'b'], caption: 'c' }] });
  const runs = [];
  const run = async ({ schema, prompt, onPartial }) => {
    runs.push(Object.keys(schema.properties).join(','));
    if (schema.properties.summary) {
      const json = JSON.stringify(FULL);
      for (let n = 40; n < json.length; n += 60) {
        await new Promise((r) => setTimeout(r, 2));
        onPartial?.(json.slice(0, n));
      }
      return FULL;
    }
    if (schema.properties.map) return { map: { nodes: [{ id: 'x', label: 'X', section: 0 }, { id: 'y', label: 'Y', section: 1 }], links: [] } };
    const from = Number(prompt.match(/numbers (\d+) to (\d+)/)[1]);
    const to = Number(prompt.match(/numbers (\d+) to (\d+)/)[2]);
    return { sections: Array.from({ length: to - from + 1 }, (_, j) => visualFor(from + j)) };
  };
  await withBridge(async ({ base }) => {
    const body = { sourceTitle: 'P', chapterTitle: 'C', pageRange: [2, 5], text: '[[p 2]] hello' };
    const events = (await (await post(`${base}/explain`, body)).text()).trim().split('\n').map((l) => JSON.parse(l));
    const partials = events.filter((e) => e.type === 'analysis' && e.partial);
    assert.ok(partials.length >= 2, 'sections arrive one by one');
    assert.ok(partials[0].analysis.sections.length < 5);
    const final = events.find((e) => e.type === 'analysis' && !e.partial);
    assert.equal(final.analysis.sections.length, 5);
    assert.equal(final.analysis.glossary.length, 1);
    const vis = events.filter((e) => e.type === 'visuals' && !e.partial).pop();
    assert.equal(vis.visuals.sections.filter(Boolean).length, 5);
    assert.ok(vis.visuals.map);
    assert.equal(events.at(-1).type, 'end');
    assert.equal(runs.filter((r) => r === 'sections').length, 2, '5 sections = batches of 3 + 2');
    // Both are cached now: no new Claude calls, and /visualize hits the same cache.
    const before = runs.length;
    const again = (await (await post(`${base}/explain`, body)).text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(again.filter((e) => e.type === 'visuals').length, 1);
    const v = await (await post(`${base}/visualize`, { ...body, sections: final.analysis.sections })).json();
    assert.equal(v.cached, true);
    assert.equal(runs.length, before);
  }, { run });
});
