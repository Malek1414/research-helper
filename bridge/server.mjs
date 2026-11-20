// Local bridge between the extension and Claude Code. Listens on 127.0.0.1 only
// and only answers the extension (chrome-extension:// origins) or local tools.
// With --lan (npm run mobile) it also listens on the Wi-Fi network for the iPhone
// app; every request from another device then needs the pairing token
// (GET /pair?t=<token> sets it as a cookie).
//   GET  /          -> localhost web app (web/index.html, serves extension/ files)
//   GET  /fetch?url= -> a PDF downloaded for the web app
//   GET  /health   -> {ok, model}
//   POST /explain  -> NDJSON stream: the analysis section by section, then whiteboards
//                     drawn in parallel batches while the text is still coming (both cached)
//   POST /analyze  -> chapter analysis (cached on disk)
//   POST /visualize -> whiteboard visuals + concept map for an analysed chapter (cached)
//   POST /trace    -> step-by-step trace of a piece of code (cached)
//   POST /listings -> code / pseudo-code found in a chapter (cached)
//   POST /ask      -> {answer}
//   POST /export   -> {file, glossary}
import { createServer as createHttpServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { hostname, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_SCHEMA, validateAnalysis } from './schema.mjs';
import { PROMPT_VERSION, analyzePrompt, askPrompt } from './prompts.mjs';
import { runClaude } from './claude.mjs';
import { MAP_SCHEMA, VISUAL_SECTIONS_SCHEMA, VISUAL_VERSION, mapPrompt, validateVisuals, visualBatchPrompt } from './visual.mjs';
import { completeItems } from './partial.mjs';
import { DEFAULT_ABOUT_ME } from './prompts.mjs';
import { LISTINGS_SCHEMA, TRACE_SCHEMA, TRACE_VERSION, listingsPrompt, tracePrompt, validateListings, validateTrace } from './trace.mjs';
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

// True for loopback, private, link-local, CGNAT, multicast and other non-public addresses.
export function isPrivateAddress(addr) {
  let a = addr.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 198 && (y === 18 || y === 19));
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
}

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
  allowPrivateFetch = false, // tests only
  lanToken = null, // set: other devices on the network may connect with this token
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

  const BATCH = 3;
  const visualSecs = (sections) => sections.slice(0, 20).map((s) => ({ title: String(s.title || ''), page: s.page, explanation: String(s.explanation || '') }));
  const visualsKey = (text, aboutMe, secs) => 'v' + createHash('sha256').update(JSON.stringify({ v: VISUAL_VERSION, model, aboutMe: aboutMe || '', text, secs })).digest('hex').slice(0, 31);

  // Draws whiteboards in parallel batches of BATCH sections plus one small call for
  // the concept map. feed() can start batches while the analysis is still streaming.
  function visualDrawer({ sourceTitle, chapterTitle, text, aboutMe, onUpdate = () => {} }) {
    const about = aboutMe || DEFAULT_ABOUT_ME;
    const raws = [];
    const jobs = [];
    const errors = [];
    let map = null;
    let count = 0;
    let next = 0;
    let mapStarted = false;
    const update = () => {
      try { onUpdate(validateVisuals({ map, sections: raws }, count)); } catch { /* nothing drawable yet */ }
    };
    const batch = (secs, from, to) => jobs.push(run({
      prompt: visualBatchPrompt({ aboutMe: about, sourceTitle, chapterTitle, sections: secs.slice(from, to), offset: from, text }),
      schema: VISUAL_SECTIONS_SCHEMA, model,
    }).then((raw) => {
      (Array.isArray(raw?.sections) ? raw.sections : []).forEach((v, j) => {
        const i = Number.isInteger(v?.section) && v.section >= from && v.section < to ? v.section : from + j;
        if (i < to) raws.push({ ...v, section: i });
      });
      update();
    }, (e) => errors.push(e)));
    const drawer = {
      feed(secs, final = false) {
        count = Math.max(count, secs.length);
        while (secs.length - next >= BATCH || (final && next < secs.length)) {
          const to = Math.min(secs.length, next + BATCH);
          batch(secs, next, to);
          next = to;
        }
        if (final && !mapStarted) {
          mapStarted = true;
          jobs.push(run({ prompt: mapPrompt({ sourceTitle, chapterTitle, sections: secs }), schema: MAP_SCHEMA, model })
            .then((raw) => { map = raw?.map || null; update(); }, (e) => errors.push(e)));
        }
      },
      async finish(secs) {
        drawer.feed(secs, true);
        for (let n = 0; n < jobs.length; n = jobs.length) await Promise.all(jobs.slice(n));
        if (!raws.length) throw errors[0] || new Error('no usable visuals');
        return validateVisuals({ map, sections: raws }, secs.length);
      },
    };
    return drawer;
  }

  async function visualize(body) {
    const { sourceTitle, chapterTitle, sections, text, aboutMe, force } = body;
    if (!text || !Array.isArray(sections) || !sections.length) throw Object.assign(new Error('text and sections are required'), { status: 400 });
    const secs = visualSecs(sections);
    const key = visualsKey(text, aboutMe, secs);
    const file = join(cacheDir, `${key}.json`);
    if (!force && existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), cached: true };
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const t0 = Date.now();
      log(`visualize "${sourceTitle}" / "${chapterTitle}" (${secs.length} sections in parallel, ${model})`);
      const visuals = await visualDrawer({ sourceTitle, chapterTitle, text, aboutMe, onUpdate: body.onUpdate }).finish(secs);
      writeFileSync(file, JSON.stringify(visuals));
      log(`visuals done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${visuals.sections.filter(Boolean).length}/${secs.length} drawn`);
      return { ...visuals, cached: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  // The fast path the viewer uses: streams the analysis as each section is
  // finished and starts drawing whiteboards for finished sections right away.
  // emit({type: 'analysis'|'visuals', ...}); partial events carry partial: true.
  async function explainPipeline(body, emit) {
    const { sourceTitle, chapterTitle, pageRange, text, storySoFar, aboutMe, force } = body;
    const key = createHash('sha256').update(JSON.stringify({ v: PROMPT_VERSION, model, aboutMe: aboutMe || '', text })).digest('hex').slice(0, 32);
    const file = join(cacheDir, `${key}.json`);
    let analysis = !force && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const t0 = Date.now();
    const drawer = body.visuals === false ? null : visualDrawer({
      sourceTitle, chapterTitle, text, aboutMe,
      onUpdate: (visuals) => emit({ type: 'visuals', visuals, partial: true }),
    });
    if (!analysis) {
      log(`explain "${sourceTitle}" / "${chapterTitle}" (${text.length} chars, streaming, ${model})`);
      let seen = 0;
      const raw = await run({
        prompt: analyzePrompt({ aboutMe, sourceTitle, chapterTitle, pageRange, storySoFar, text }), schema: ANALYSIS_SCHEMA, model,
        onPartial: (json) => {
          const items = completeItems(json, 'sections');
          if (items.length <= seen) return;
          seen = items.length;
          let sections;
          try { sections = validateAnalysis({ sections: items }, pageRange).sections; } catch { return; }
          if (seen === 1 || sections.length === 1) log(`first section after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          emit({ type: 'analysis', partial: true, analysis: { summary: '', sections, glossary: [], buildCard: null } });
          drawer?.feed(visualSecs(sections));
        },
      });
      analysis = validateAnalysis(raw, pageRange);
      writeFileSync(file, JSON.stringify(analysis));
      log(`text done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${analysis.sections.length} sections`);
    }
    emit({ type: 'analysis', analysis });
    if (!drawer) return;
    const secs = visualSecs(analysis.sections);
    const vkey = visualsKey(text, aboutMe, secs);
    const vfile = join(cacheDir, `${vkey}.json`);
    if (!force && existsSync(vfile)) return emit({ type: 'visuals', visuals: JSON.parse(readFileSync(vfile, 'utf8')) });
    try {
      const visuals = await drawer.finish(secs);
      writeFileSync(vfile, JSON.stringify(visuals));
      log(`visuals done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${visuals.sections.filter(Boolean).length}/${secs.length} drawn`);
      emit({ type: 'visuals', visuals });
    } catch (e) {
      emit({ type: 'visuals', error: e.message });
    }
  }

  // Streamed jobs are shared: a second request for the same chapter (say the
  // prefetch and then the reader opening it) joins the running one.
  const streams = new Map();
  function explainJob(body) {
    const { text, pageRange } = body;
    if (!text || !Array.isArray(pageRange)) throw Object.assign(new Error('text and pageRange are required'), { status: 400 });
    const key = createHash('sha256').update(JSON.stringify({ model, aboutMe: body.aboutMe || '', text, visuals: body.visuals !== false })).digest('hex');
    let job = streams.get(key);
    if (job && !body.force) return job;
    job = { last: new Map(), subs: new Set() };
    const emit = (ev) => {
      job.last.set(ev.type, ev);
      for (const f of job.subs) f(ev);
    };
    job.done = explainPipeline(body, emit).finally(() => streams.get(key) === job && streams.delete(key));
    job.done.catch(() => {});
    streams.set(key, job);
    return job;
  }

  // Disk-cached, de-duplicated Claude job.
  function cachedJob(prefix, keyParts, force, label, work) {
    const key = prefix + createHash('sha256').update(JSON.stringify({ model, ...keyParts })).digest('hex').slice(0, 31);
    const file = join(cacheDir, `${key}.json`);
    if (!force && existsSync(file)) return Promise.resolve({ ...JSON.parse(readFileSync(file, 'utf8')), cached: true });
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const t0 = Date.now();
      log(label);
      const out = await work();
      writeFileSync(file, JSON.stringify(out));
      log(`${label.split(' ')[0]} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return { ...out, cached: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function trace(body) {
    const code = String(body.code || '').replace(/\s+$/, '');
    if (!code.trim()) throw Object.assign(new Error('code is required'), { status: 400 });
    if (code.length > 12000) throw Object.assign(new Error('code too long to trace (keep it under ~200 lines)'), { status: 413 });
    const aboutMe = body.aboutMe || DEFAULT_ABOUT_ME;
    return cachedJob('t', { v: TRACE_VERSION, code, language: body.language || '', aboutMe }, body.force, `trace ${body.language || 'code'} "${body.title || ''}" (${code.split('\n').length} lines, ${model})`, async () =>
      validateTrace(await run({ prompt: tracePrompt({ aboutMe, code, language: body.language, title: body.title, context: body.context }), schema: TRACE_SCHEMA, model }), code));
  }

  async function listings(body) {
    const { text, pageRange } = body;
    if (!text || !Array.isArray(pageRange)) throw Object.assign(new Error('text and pageRange are required'), { status: 400 });
    return cachedJob('l', { v: TRACE_VERSION, text }, body.force, `listings "${body.chapterTitle || ''}" (${text.length} chars, ${model})`, async () =>
      validateListings(await run({ prompt: listingsPrompt({ text, pageRange }), schema: LISTINGS_SCHEMA, model }), pageRange));
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
    'POST /visualize': visualize,
    'POST /trace': trace,
    'POST /listings': listings,
    'POST /ask': ask,
    'POST /export': doExport,
  };

  const server = createHttpServer(async (req, res) => {
    const port = server.address().port;
    const own = [`127.0.0.1:${port}`, `localhost:${port}`];
    // Through a tunnel (Tailscale Funnel, Cloudflare) requests arrive from loopback
    // but come from the internet: the forwarding headers give them away.
    const proxied = ['x-forwarded-for', 'cf-connecting-ip', 'tailscale-funnel-request', 'forwarded'].some((h) => req.headers[h]);
    const remote = proxied || !isLoopback(req.socket.remoteAddress);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    if (remote && process.env.RH_DEBUG) log(`lan ${req.method} ${req.url.replace(/t=[^&]+/, 't=…')}`);
    if (remote) {
      // Another device (the iPhone app): only in LAN mode and only with the token.
      if (!lanToken) return void res.writeHead(403).end();
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/pair') {
        if (!sameToken(url.searchParams.get('t'), lanToken)) return void res.writeHead(401).end('wrong pairing code');
        res.writeHead(302, { 'set-cookie': `rh_t=${lanToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`, location: url.searchParams.get('next') === 'mobile' ? '/m' : '/' }).end();
        return;
      }
      if (!sameToken(cookie(req, 'rh_t'), lanToken)) return void res.writeHead(401, { 'content-type': 'text/plain' }).end('Not paired. Open the Research Helper app and pair it with this Mac.');
      own.push(req.headers.host);
    }
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
    if (req.method === 'POST' && url.pathname === '/explain') return streamExplain(req, res, headers);
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const start = remote && lanToken ? `/pair?t=${lanToken}&next=mobile` : '/m';
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' }).end(JSON.stringify({
        name: 'Research Helper', short_name: 'Research', description: 'Read hard papers, then build them.',
        start_url: start, scope: '/', display: 'standalone', background_color: '#0B0B0C', theme_color: '#0B0B0C',
        icons: [
          { src: '/web/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/web/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/web/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      }));
      return;
    }
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

  async function streamExplain(req, res, headers) {
    let job;
    try {
      job = explainJob(await readBody(req));
    } catch (e) {
      res.writeHead(e.status || 500, headers).end(JSON.stringify({ error: e.message }));
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    res.flushHeaders?.();
    const write = (ev) => res.write(JSON.stringify(ev) + '\n');
    for (const ev of job.last.values()) write(ev);
    job.subs.add(write);
    res.on('close', () => job.subs.delete(write));
    job.done.then(
      () => write({ type: 'end' }),
      (e) => { log(`error: ${e.message}`); write({ type: 'error', error: e.message }); },
    ).finally(() => {
      job.subs.delete(write);
      res.end();
    });
  }

  // Downloads a PDF for the web app (pages cannot fetch other sites' files).
  async function proxyPdf(target, res, headers) {
    try {
      const r = await safeFetch(target);
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

  // Fetches a public http(s) URL only: every hop (redirects included) must resolve
  // to public addresses, so the proxy cannot be pointed at this Mac or the local network.
  async function safeFetch(target, hops = 5) {
    let url;
    try {
      url = new URL(target);
    } catch {
      throw Object.assign(new Error('invalid url'), { status: 400 });
    }
    if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('url must be http(s)'), { status: 400 });
    if (!allowPrivateFetch) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
      if (!addrs.length) throw Object.assign(new Error('host not found'), { status: 502 });
      if (addrs.some((x) => isPrivateAddress(x.address))) throw Object.assign(new Error('refusing to fetch a private or local address'), { status: 403 });
    }
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(90000), headers: { 'user-agent': 'ResearchHelper/0.1' } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      if (hops <= 0) throw Object.assign(new Error('too many redirects'), { status: 502 });
      return safeFetch(new URL(r.headers.get('location'), url).href, hops - 1);
    }
    return r;
  }

  // The localhost web app: / is web/index.html; /web/* and /extension/* are files.
  function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'web/index.html' : pathname === '/m' ? 'web/mobile.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!/^(web|extension)\//.test(rel)) return false;
    const file = resolve(ROOT, rel);
    if (!file.startsWith(join(ROOT, rel.split('/')[0]) + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
    return true;
  }

  return server;
}

const isLoopback = (a = '') => a === '::1' || a.replace(/^::ffff:/, '').startsWith('127.');

function sameToken(a, b) {
  if (typeof a !== 'string' || !a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// The pairing token for the iPhone app, kept in .cache so pairing survives restarts.
export function mobileToken(file = join(ROOT, '.cache', 'mobile-token')) {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const t = randomBytes(18).toString('base64url');
  writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address)) return i.address;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lan = process.argv.includes('--lan') || process.env.RH_LAN === '1';
  // The token is always on, so the app is safe behind a tunnel (npm run phone).
  const token = mobileToken();
  createBridge({ lanToken: token }).listen(PORT, lan ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`Research Helper on http://127.0.0.1:${PORT}  (web app + bridge for the extension, model: ${process.env.RH_MODEL || 'sonnet'})`);
    if (lan) {
      const host = `${hostname().replace(/\.local$/, '')}.local`;
      console.log(`iPhone: open the Research Helper app. Pairing link: http://${lanAddress() || host}:${PORT}/pair?t=${token}&next=mobile`);
    }
  });
}
