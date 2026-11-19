// Launches Chrome for Testing with the unpacked extension (headless) for scripts and e2e.
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

export function findChrome() {
  if (process.env.RH_CHROME) return process.env.RH_CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  return undefined; // Playwright's own download
}

export async function launch({ headless = true } = {}) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'rh-chrome-')), {
    executablePath: findChrome(),
    headless,
    viewport: { width: 1500, height: 1000 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  return { ctx, id: new URL(sw.url()).host };
}
