// E2E for the two launch paths the Claude Code plugin uses:
//  1. localhost web app:  http://127.0.0.1:4317/?add=<pdf>&explain=1
//  2. extension import:   chrome-extension://<id>/import.html?url=<pdf>&explain=1
// Both should add the paper, open it and explain it without any clicks.
//   node scripts/e2e-web.mjs <pdf url> [outDir]
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, EXT, findChrome } from './browser.mjs';

const pdf = process.argv[2] || 'https://arxiv.org/pdf/1706.03762v7';
const out = process.argv[3] || join(EXT, '..', '.cache', 'e2e-web');
mkdirSync(out, { recursive: true });
const DONE = /explained|error|offline|Could not/i;

// 1. Web app (plain Chromium, no extension).
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('[web error]', e.message));
await page.goto(`http://127.0.0.1:4317/?add=${encodeURIComponent(pdf)}&title=${encodeURIComponent('Attention Is All You Need')}&explain=1`);
const viewer = page.frameLocator('#viewer');
await viewer.locator('#status').filter({ hasText: DONE }).waitFor({ timeout: 6 * 60 * 1000 });
console.log('web viewer:', await viewer.locator('#status').textContent(), '| title:', await viewer.locator('#title').textContent());
console.log('web panel cards:', await page.frameLocator('#panel').locator('.card').count());
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, 'web-app.png') });
// Reload: library and analysis must persist.
await page.goto('http://127.0.0.1:4317/');
await viewer.locator('#status').filter({ hasText: DONE }).waitFor({ timeout: 60000 });
console.log('web after reload:', await viewer.locator('#status').textContent(), '| sources:', await page.frameLocator('#panel').locator('#sources li').count());
await browser.close();

// 2. Extension import page (fixed extension ID from the manifest key).
const id = readFileSync(join(EXT, 'EXTENSION_ID'), 'utf8').trim();
const { ctx, id: loadedId } = await launch();
console.log('extension id matches fixed id:', loadedId === id);
const opened = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('viewer.html'), timeout: 60000 }).catch(() => null);
const imp = await ctx.newPage();
await imp.goto(`chrome-extension://${id}/import.html?url=${encodeURIComponent(pdf)}&explain=1`);
const v = (await opened) || ctx.pages().find((p) => p.url().includes('viewer.html'));
if (!v) throw new Error('extension did not open the viewer');
await v.waitForFunction((re) => new RegExp(re, 'i').test(document.getElementById('status').textContent), DONE.source, { timeout: 6 * 60 * 1000 });
console.log('extension viewer:', await v.textContent('#status'), '| import tab closed:', imp.isClosed());
await v.screenshot({ path: join(out, 'extension-import.png') });
await ctx.close();
console.log('screenshots in', out);
