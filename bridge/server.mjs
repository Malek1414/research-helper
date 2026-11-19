// Local bridge between the extension and Claude Code. Listens on 127.0.0.1 only
// and only answers the extension (chrome-extension:// origins) or local tools.
//   GET  /          -> localhost web app (web/index.html, serves extension/ files)
//   GET  /fetch?url= -> a PDF downloaded for the web app
//   GET  /health   -> {ok, model}
//   POST /analyze  -> chapter analysis (cached on disk)
//   POST /ask      -> {answer}
//   POST /export   -> {file, glossary}
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_SCHEMA, validateAnalysis } from './schema.mjs';
import { PROMPT_VERSION, analyzePrompt, askPrompt } from './prompts.mjs';
import { runClaude } from './claude.mjs';
import { writeExport } from './export.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.RH_PORT || 4317);
const MAX_BODY = 30 * 1024 * 1024;
const MAX_PDF = 200 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.gif': 'image/gif', '.bcmap': 'application/octet-stream',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createBridge({
  run = runClaude,
  cacheDir = join(ROOT, '.cache', 'analyses'),
  libraryDir = join(ROOT, 'library'),
  model = process.env.RH_MODEL || 'sonnet',
  log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a),
} = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const inflight = new Map();

  async function analyze(body) {
    const { sourceTitle, chapterTitle, pageRange, text, storySoFar, aboutMe, force } = body;
    if (!text || !Array.isArray(pageRange)) throw Object.assign(new Error('text and pageRange are required'), { status: 400 });
    const key = createHash('sha256').update(JSON.stringify({ v: PROMPT_VERSION, model, aboutMe: aboutMe || '', text })).digest('hex').slice(0, 32);
    const file = join(cacheDir, `${key}.json`);
    if (!force && existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), cached: true };
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const t0 = Date.now();
      log(`analyze "${sourceTitle}" / "${chapterTitle}" (${text.length} chars, ${model})`);
      const raw = await run({ prompt: analyzePrompt({ aboutMe, sourceTitle, chapterTitle, pageRange, storySoFar, text }), schema: ANALYSIS_SCHEMA, model });
      const analysis = validateAnalysis(raw, pageRange);
      writeFileSync(file, JSON.stringify(analysis));
      log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${analysis.sections.length} sections`);
      return { ...analysis, cached: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function ask(body) {
    if (!body.question) throw Object.assign(new Error('question is required'), { status: 400 });
    log(`ask: ${body.question.slice(0, 80)}`);
    return { answer: await run({ prompt: askPrompt(body), model }) };
  }

  function doExport(body) {
    if (!body.source || !body.chapter || !body.analysis) throw Object.assign(new Error('source, chapter and analysis are required'), { status: 400 });
    const out = writeExport(libraryDir, body);
    log(`exported ${out.file}`);
    return out;
  }

  const routes = {
    'GET /health': async () => ({ ok: true, web: true, model, version: PROMPT_VERSION }),
    'POST /analyze': analyze,
    'POST /ask': ask,
    'POST /export': doExport,
  };

  const server = createHttpServer(async (req, res) => {
    const port = server.address().port;
    const own = [`127.0.0.1:${port}`, `localhost:${port}`];
    // Host check stops DNS-rebinding pages; origin check stops other websites.
    if (!own.includes(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    const origin = req.headers.origin;
    const ownOrigin = origin && own.some((h) => origin === `http://${h}`);
    if (origin && !ownOrigin && !origin.startsWith('chrome-extension://')) {
      res.writeHead(403).end();
      return;
    }
    const headers = { 'content-type': 'application/json' };
    if (origin && !ownOrigin) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-headers'] = 'content-type';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      headers['vary'] = 'origin';
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers).end();
      return;
    }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/fetch') return proxyPdf(url.searchParams.get('url'), res, headers);
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
      res.writeHead(404, headers).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await route(body);
      res.writeHead(200, headers).end(JSON.stringify(result));
    } catch (e) {
      log(`error: ${e.message}`);
      res.writeHead(e.status || 500, headers).end(JSON.stringify({ error: e.message }));
    }
  });

  // Downloads a PDF for the web app (pages cannot fetch other sites' files).
  async function proxyPdf(target, res, headers) {
    try {
      if (!/^https?:\/\//i.test(target || '')) throw Object.assign(new Error('url must be http(s)'), { status: 400 });
      const r = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(90000), headers: { 'user-agent': 'ResearchHelper/0.1' } });
      if (!r.ok) throw Object.assign(new Error(`download failed (${r.status})`), { status: 502 });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_PDF) throw Object.assign(new Error('PDF too large'), { status: 413 });
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw Object.assign(new Error('that link is not a PDF'), { status: 415 });
      log(`fetched ${target} (${(buf.length / 1e6).toFixed(1)} MB)`);
      res.writeHead(200, { ...headers, 'content-type': 'application/pdf' }).end(buf);
    } catch (e) {
      log(`fetch error: ${e.message}`);
      res.writeHead(e.status || 502, headers).end(JSON.stringify({ error: e.message }));
    }
  }

  // The localhost web app: / is web/index.html; /web/* and /extension/* are files.
  function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'web/index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!/^(web|extension)\//.test(rel)) return false;
    const file = resolve(ROOT, rel);
    if (!file.startsWith(join(ROOT, rel.split('/')[0]) + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
    return true;
  }

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createBridge().listen(PORT, '127.0.0.1', () => {
    console.log(`Research Helper on http://127.0.0.1:${PORT}  (web app + bridge for the extension, model: ${process.env.RH_MODEL || 'sonnet'})`);
  });
}
