#!/usr/bin/env node
// Hands a paper to Research Helper: checks the PDF link, makes sure the local
// server (bridge + web app) runs, and prints the URL to open.
//
//   node launch.mjs --url <pdf> [--title "..."] [--target web|chrome] [--no-explain] [--open]
//   node launch.mjs --app [--open]          just start/open the localhost app
//
// --target web     (default) localhost web app, PDF left + explainer right
// --target chrome  the Chrome extension (must be loaded unpacked once)
// --open           also open the URL with macOS `open` in Google Chrome
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.RH_HOME || join(homedir(), 'Desktop', 'research-helper');
const PORT = Number(process.env.RH_PORT || 4317);
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (k) => args.includes(`--${k}`);
const fail = (msg, code = 1) => {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
};

async function healthy() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function ensureServer() {
  const h = await healthy();
  if (h?.web) return 'running';
  if (h) fail(`An older Research Helper bridge is running on port ${PORT}. Stop it (Ctrl-C in its terminal, or: kill $(lsof -ti tcp:${PORT})) and run this again.`);
  if (!existsSync(join(HOME, 'bridge', 'server.mjs'))) fail(`Research Helper not found at ${HOME}. Set RH_HOME.`);
  if (!existsSync(join(HOME, 'extension', 'vendor', 'pdf.mjs'))) fail(`Run once: cd ${HOME} && npm install && npm run setup`);
  mkdirSync(join(HOME, '.cache'), { recursive: true });
  const log = openSync(join(HOME, '.cache', 'bridge.log'), 'a');
  spawn(process.execPath, [join(HOME, 'bridge', 'server.mjs')], { cwd: HOME, detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if ((await healthy())?.web) return 'started';
  }
  fail(`Server did not start; see ${join(HOME, '.cache', 'bridge.log')}`);
}

async function checkPdf(url) {
  try {
    const ctrl = new AbortController();
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(45000)]), headers: { 'user-agent': 'ResearchHelper/0.1' } });
    if (!r.ok) return `download failed (${r.status})`;
    const reader = r.body.getReader();
    const { value } = await reader.read();
    ctrl.abort();
    return Buffer.from(value || []).subarray(0, 5).toString('latin1') === '%PDF-' ? null : 'that link is not a PDF (a landing page or paywall?)';
  } catch (e) {
    return `could not reach it: ${e.message}`;
  }
}

const url = opt('url');
const app = flag('app');
if (!url && !app) fail('usage: launch.mjs --url <pdf> [--title ...] [--target web|chrome] [--no-explain] [--open] | --app');
const target = opt('target') || 'web';
if (!['web', 'chrome'].includes(target)) fail('--target must be web or chrome');

if (url) {
  const bad = await checkPdf(url);
  if (bad) fail(`PDF check failed for ${url}: ${bad}`, 2);
}
const server = await ensureServer();

const q = new URLSearchParams();
if (url) {
  q.set(target === 'web' ? 'add' : 'url', url);
  if (opt('title')) q.set('title', opt('title'));
  if (!flag('no-explain')) q.set('explain', '1');
}
let open;
if (target === 'chrome') {
  const id = readFileSync(join(HOME, 'extension', 'EXTENSION_ID'), 'utf8').trim();
  open = url ? `chrome-extension://${id}/import.html?${q}` : `chrome-extension://${id}/viewer/viewer.html`;
} else {
  open = url ? `${BASE}/?${q}` : `${BASE}/`;
}

if (flag('open')) {
  try {
    execFileSync('open', ['-a', 'Google Chrome', open]);
  } catch {
    execFileSync('open', [open]);
  }
}
console.log(JSON.stringify({ ok: true, target, server, open, opened: flag('open') }));
