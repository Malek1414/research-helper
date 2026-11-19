// Copies the browser builds of pdf.js, rough.js and the Caveat handwriting font
// into extension/vendor so the unpacked extension has no build step.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'extension', 'vendor');

const files = [
  ['pdfjs-dist/build/pdf.mjs', 'pdf.mjs'],
  ['pdfjs-dist/build/pdf.worker.mjs', 'pdf.worker.mjs'],
  ['pdfjs-dist/web/pdf_viewer.css', 'pdf_viewer.css'],
  ['roughjs/bundled/rough.esm.js', 'rough.esm.js'],
  ['@fontsource/caveat/files/caveat-latin-400-normal.woff2', 'caveat-400.woff2'],
  ['@fontsource/caveat/files/caveat-latin-600-normal.woff2', 'caveat-600.woff2'],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of files) cpSync(join(nm, from), join(out, to));
cpSync(join(nm, 'pdfjs-dist/web/images'), join(out, 'images'), { recursive: true });
console.log(`vendored ${files.length} files into extension/vendor`);
