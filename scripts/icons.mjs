// Draws the toolbar icon (a page with a red highlight stroke) as PNGs, no deps.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function png(size, px) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const [r, g, b, a] = px(x / size, y / size); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const draw = (u, v) => {
  const inPage = u > 0.18 && u < 0.82 && v > 0.08 && v < 0.92;
  if (!inPage) return [0, 0, 0, 0];
  if (v > 0.44 && v < 0.58 && u > 0.26 && u < 0.74) return [204, 59, 82, 255]; // highlight
  for (const line of [0.24, 0.34, 0.68, 0.78]) if (Math.abs(v - line) < 0.025 && u > 0.28 && u < (line > 0.6 ? 0.62 : 0.72)) return [110, 110, 116, 255];
  return [236, 234, 228, 255];
};
for (const s of [16, 48, 128]) writeFileSync(new URL(`../extension/icons/${s}.png`, import.meta.url), png(s, draw));
console.log('icons written');
