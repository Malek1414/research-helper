// End-to-end check: loads the unpacked extension in Chrome for Testing, adds a
// PDF, explains its first chapter through the running bridge, and saves screenshots.
//   npm run bridge            (in another terminal)
//   npm run e2e -- path/to/paper.pdf [outDir]
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdf = resolve(process.argv[2] || '');
const out = resolve(process.argv[3] || join(ROOT, '.cache', 'e2e'));
if (!existsSync(pdf)) throw new Error('usage: npm run e2e -- paper.pdf [outDir]');
mkdirSync(out, { recursive: true });

const { ctx, id } = await launch();
console.log('extension', id);

const panel = await ctx.newPage();
panel.setViewportSize({ width: 420, height: 1000 });
panel.on('console', (m) => m.type() === 'error' && console.log('[panel]', m.text()));
panel.on('pageerror', (e) => console.log('[panel error]', e.message));
await panel.goto(`chrome-extension://${id}/sidepanel/panel.html`);
await panel.waitForSelector('#bridge.on', { timeout: 10000 }).catch(() => console.log('bridge looks offline'));

const viewerPromise = ctx.waitForEvent('page');
await panel.setInputFiles('#file', pdf);
const viewer = await viewerPromise;
await viewer.waitForURL(/\/viewer\/viewer\.html/);
viewer.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log('[viewer]', m.text()));
viewer.on('pageerror', (e) => console.log('[viewer error]', e.message));
await viewer.waitForSelector('.page-wrap .textLayer span', { timeout: 60000 });
await viewer.waitForFunction(() => /Ready|explained|OCR/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
console.log('viewer:', await viewer.textContent('#status'), '| chapters:', await viewer.$$eval('#chapter option', (o) => o.map((x) => x.textContent.trim())));
await viewer.screenshot({ path: join(out, '1-viewer-loaded.png') });

const t0 = Date.now();
await panel.bringToFront();
await panel.click('#explain-cta');
await viewer.waitForFunction(() => /explained|error|offline|Claude error/i.test(document.getElementById('status').textContent), null, { timeout: 8 * 60 * 1000, polling: 2000 });
console.log(`explain took ${((Date.now() - t0) / 1000).toFixed(0)}s:`, await viewer.textContent('#status'));

const counts = await viewer.evaluate(() => ({
  highlights: document.querySelectorAll('.hl').length,
  notes: document.querySelectorAll('.ink').length,
}));
console.log('drawn:', counts);
await viewer.bringToFront();
const firstNote = await viewer.$('.ink');
if (firstNote) await firstNote.scrollIntoViewIfNeeded();
await viewer.waitForTimeout(800);
await viewer.screenshot({ path: join(out, '2-viewer-annotated.png') });
await panel.bringToFront();
await panel.waitForTimeout(500);
await panel.screenshot({ path: join(out, '3-panel-walkthrough.png'), fullPage: true });

// Guided walk + build card + export.
await panel.click('.seg button[data-mode="walk"]');
await panel.waitForSelector('#w-next');
await panel.click('#w-next');
await viewer.waitForTimeout(1500);
await viewer.screenshot({ path: join(out, '4-viewer-walk.png') });
await panel.screenshot({ path: join(out, '5-panel-walk.png') });
await panel.click('.tabs button[data-tab="build"]');
await panel.screenshot({ path: join(out, '6-panel-build.png'), fullPage: true });
await panel.click('#export');
await panel.waitForFunction(() => /Saved|rror|offline/.test(document.getElementById('export-status')?.textContent || ''), null, { timeout: 20000 });
console.log('export:', await panel.textContent('#export-status'));
console.log('progress:', await panel.textContent('#src-label'));
await panel.screenshot({ path: join(out, '7-panel-after-export.png'), fullPage: true });
await ctx.close();
console.log('screenshots in', out);
