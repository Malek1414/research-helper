// Prints how Research Helper splits PDFs into chapters, using the real extension
// in Chrome for Testing (pdf.js 6 needs a current browser, not Node).
//   node scripts/chapters.mjs book.pdf [more.pdf ...]
import { launch } from './browser.mjs';

const { ctx, id } = await launch();
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/sidepanel/panel.html`);
for (const file of process.argv.slice(2)) {
  const opened = ctx.waitForEvent('page');
  await panel.setInputFiles('#file', file);
  const viewer = await opened;
  await viewer.waitForURL(/viewer\.html/);
  await viewer.waitForFunction(() => /Ready|explained|OCR|Could not/.test(document.getElementById('status').textContent), null, { timeout: 180000 });
  const src = await panel.evaluate(async () => {
    const { sources, activeId } = await chrome.storage.local.get(['sources', 'activeId']);
    return sources.find((s) => s.id === activeId);
  });
  console.log(`\n${src.title}  (${src.numPages} pages, ${src.chapters.length} chapters)`);
  for (const c of src.chapters) console.log(`  p${String(c.start + 1).padStart(4)}-${String(c.end + 1).padEnd(4)} ${c.title}`);
  await viewer.close();
}
await ctx.close();
