// Draws highlights (under the text layer) and handwritten margin notes (rough.js
// strokes + Caveat text in the right gutter) on rendered pages.
import rough from '../vendor/rough.esm.js';
import { findQuote } from '../shared/anchor.js';

export const INK = '#F0163A';
const HL = { 1: 'rgba(255, 221, 87, .55)', 2: 'rgba(255, 221, 87, .55)', 3: 'rgba(255, 180, 70, .5)', 4: 'rgba(255, 120, 140, .45)', 5: 'rgba(255, 120, 140, .45)' };
const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

// Text nodes of a pdf.js text layer, in reading order.
export function textNodes(textLayer) {
  const out = [];
  const w = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) out.push(w.currentNode);
  return out;
}

// Finds a quote on a page and returns its line boxes relative to the page element.
export function anchorRects(pageEl, nodes, quote) {
  const hit = findQuote(nodes.map((n) => n.data), quote);
  if (!hit) return null;
  const range = document.createRange();
  range.setStart(nodes[hit.startSeg], hit.startOff);
  range.setEnd(nodes[hit.endSeg], hit.endOff);
  const base = pageEl.getBoundingClientRect();
  const raw = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  // Merge boxes on the same line.
  const lines = [];
  for (const r of raw.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const box = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
    const line = lines.find((l) => Math.abs(l.y + l.h / 2 - (box.y + box.h / 2)) < Math.max(l.h, box.h) * 0.5);
    if (line) {
      const x2 = Math.max(line.x + line.w, box.x + box.w);
      const y2 = Math.max(line.y + line.h, box.y + box.h);
      line.x = Math.min(line.x, box.x);
      line.y = Math.min(line.y, box.y);
      line.w = x2 - line.x;
      line.h = y2 - line.y;
    } else lines.push(box);
  }
  return lines.length ? { rects: lines, method: hit.method } : null;
}

export function drawHighlight(hlSvg, rects, difficulty, section) {
  const g = el('g', { class: 'hl', 'data-section': section }, hlSvg);
  for (const r of rects) el('rect', { x: r.x - 1.5, y: r.y + r.h * 0.08, width: r.w + 3, height: r.h * 0.92, rx: 2, fill: HL[difficulty] || HL[3] }, g);
  return g;
}

function wrap(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

// Draws a bracket next to the passage, an arrow into the gutter and the note text.
// Returns the bottom y of the note so notes on a page can stack without overlapping.
export function drawNote(inkSvg, { rects, note, pageWidth, gutter, minY, section, animate, scale }) {
  const rc = rough.svg(inkSvg);
  const g = el('g', { class: 'ink' + (animate ? ' animate' : ''), 'data-section': section }, inkSvg);
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const opts = { stroke: INK, strokeWidth: 1.7, roughness: 1.3, bowing: 1.2, seed: section * 7 + 3 };

  // Wavy underline under the last line, bracket along the right edge.
  const last = rects.at(-1);
  g.appendChild(rc.curve(
    Array.from({ length: 7 }, (_, i) => [last.x + (last.w * i) / 6, last.y + last.h + 2 + (i % 2 ? 1.6 : -0.6)]),
    opts,
  ));
  const bx = pageWidth + 8;
  g.appendChild(rc.path(`M ${bx - 6} ${top} Q ${bx} ${top} ${bx} ${top + 8} L ${bx} ${bottom - 8} Q ${bx} ${bottom} ${bx - 6} ${bottom}`, opts));

  const fontSize = Math.max(17, Math.min(24, 20 * scale));
  const lines = wrap(note, Math.max(10, Math.floor((gutter - 34) / (fontSize * 0.42))));
  const noteY = Math.max(minY, top - 4);
  const mid = (top + bottom) / 2;
  const tx = pageWidth + 26;
  // Arrow from the note to the bracket.
  g.appendChild(rc.curve([[tx - 2, noteY + fontSize * 0.55], [bx + 9, (noteY + mid) / 2 + 4], [bx + 3, mid]], opts));
  g.appendChild(rc.linearPath([[bx + 9, mid - 5], [bx + 3, mid], [bx + 10, mid + 3]], opts));

  const text = el('text', { x: tx, y: noteY + fontSize * 0.8, fill: INK, 'font-size': fontSize, class: 'hand' }, g);
  lines.forEach((line, i) => {
    const t = el('tspan', { x: tx, dy: i ? fontSize * 1.05 : 0 }, text);
    t.textContent = line;
  });

  if (animate) animateInk(g);
  return noteY + lines.length * fontSize * 1.05 + 14;
}

function animateInk(g) {
  let delay = 0;
  for (const p of g.querySelectorAll('path')) {
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len}`;
    p.style.transition = `stroke-dashoffset ${Math.min(0.9, 0.25 + len / 600)}s ease-in-out ${delay}s`;
    delay += 0.12;
    requestAnimationFrame(() => requestAnimationFrame(() => (p.style.strokeDashoffset = '0')));
  }
  const text = g.querySelector('text');
  if (text) text.style.animationDelay = `${delay}s`;
}
