// Local bridge between the extension and Claude Code. Listens on 127.0.0.1 only
// and only answers the extension (chrome-extension:// origins) or local tools.
//   GET  /health   -> {ok, model}
//   POST /analyze  -> chapter analysis (cached on disk)
//   POST /ask      -> {answer}
//   POST /export   -> {file, glossary}
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_SCHEMA, validateAnalysis } from './schema.mjs';
import { PROMPT_VERSION, analyzePrompt, askPrompt } from './prompts.mjs';
import { runClaude } from './claude.mjs';
import { writeExport } from './export.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.RH_PORT || 4317);
const MAX_BODY = 30 * 1024 * 1024;

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
    'GET /health': async () => ({ ok: true, model, version: PROMPT_VERSION }),
    'POST /analyze': analyze,
    'POST /ask': ask,
    'POST /export': doExport,
  };

  return createHttpServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) {
      res.writeHead(403).end();
      return;
    }
    const headers = { 'content-type': 'application/json' };
    if (origin) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-headers'] = 'content-type';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      headers['vary'] = 'origin';
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers).end();
      return;
    }
    const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
    if (!route) {
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createBridge().listen(PORT, '127.0.0.1', () => {
    console.log(`Research Helper bridge on http://127.0.0.1:${PORT} (model: ${process.env.RH_MODEL || 'sonnet'})`);
  });
}
