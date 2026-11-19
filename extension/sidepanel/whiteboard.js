// Draws a laid-out visual (shared/visual-layout.js) as a hand-drawn whiteboard:
// rough.js strokes and Caveat handwriting on paper, revealed step by step.
import rough from '../vendor/rough.esm.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = '#1F1D1C';
const RED = '#FF3B4E';
const DIM = '#6E6B68';
const TONES = ['#FFD60A', '#FF8A2A', '#FF5C8A', '#2EC5FF', '#3DDC84', '#A779FF', '#FFD60A', '#FF8A2A'];

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 2 ** 31 || 1;
}

const LH = 1.12;

function textBlock(g, { x, y, lines, size, anchor = 'middle', fill = INK, weight = 600, mono = false }) {
  const t = el('text', {
    x, y, fill, 'font-size': size, 'text-anchor': anchor, 'font-weight': weight,
    'font-family': mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Caveat, cursive',
  }, g);
  lines.forEach((line, i) => {
    const s = el('tspan', { x, dy: i ? size * LH : 0 }, t);
    s.textContent = line;
  });
  return t;
}

function arrowHead(rc, [x1, y1], [x2, y2], o) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const L = 10;
  return [a + 2.6, a - 2.6].map((t) => rc.line(x2, y2, x2 + L * Math.cos(t), y2 + L * Math.sin(t), o));
}

function drawShape(rc, g, s, seed, { current }) {
  const o = { roughness: 1.25, bowing: 1.1, stroke: INK, strokeWidth: 1.6, seed };
  switch (s.type) {
    case 'box': {
      const isCur = current !== undefined && s.section === current;
      if (!s.bare) {
        g.appendChild(rc.rectangle(s.x, s.y, s.w, s.h, {
          ...o, stroke: isCur ? RED : INK, strokeWidth: isCur ? 2.6 : 1.6,
          fill: TONES[s.tone % TONES.length], fillStyle: 'hachure', hachureGap: 7, fillWeight: 1.1, hachureAngle: -41 + (s.tone % 3) * 12,
        }));
      } else {
        g.appendChild(rc.line(s.x + 2, s.y + s.h - 2, s.x + s.w - 2, s.y + s.h - 2, { ...o, stroke: TONES[s.tone % TONES.length], strokeWidth: 5, roughness: 0.8 }));
      }
      const lineH = 19 * LH;
      const subH = 15 * LH;
      const textH = s.lines.length * lineH + (s.sub.length ? 4 + s.sub.length * subH : 0);
      const top = s.y + (s.h - textH) / 2 + 15;
      const iconW = s.icon ? 30 : 0;
      if (s.icon) {
        const ic = el('text', { x: s.x + 10, y: s.y + s.h / 2 + 8, 'font-size': 22 }, g);
        ic.textContent = s.icon;
      }
      const cx = s.icon ? s.x + 10 + iconW : s.x + s.w / 2;
      const anchor = s.icon ? 'start' : 'middle';
      textBlock(g, { x: cx, y: top, lines: s.lines, size: s.mono ? 17 : 19, anchor, mono: s.mono, fill: s.mono ? INK : INK });
      if (s.sub.length) textBlock(g, { x: cx, y: top + s.lines.length * lineH + 4, lines: s.sub, size: 15, anchor, fill: DIM, weight: 400 });
      if (s.section !== undefined && s.section >= 0) {
        g.dataset.section = s.section;
        g.classList.add('wb-node');
      }
      break;
    }
    case 'arrow': {
      const ao = { ...o, stroke: RED, strokeWidth: 1.8 };
      const pts = s.points;
      g.appendChild(pts.length > 2 ? rc.curve(pts, ao) : rc.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1], ao));
      arrowHead(rc, pts[pts.length - 2], pts[pts.length - 1], ao).forEach((p) => g.appendChild(p));
      if (s.label) textBlock(g, { x: s.lx, y: s.ly, lines: [s.label], size: 15, anchor: s.anchor, fill: RED });
      break;
    }
    case 'text': {
      const t = textBlock(g, { x: s.x, y: s.y, lines: s.lines, size: s.size, anchor: s.anchor, fill: s.color === 'red' ? RED : INK, weight: s.size >= 19 ? 600 : 500 });
      if (s.underline) {
        const w = Math.max(...s.lines.map((l) => l.length)) * s.size * 0.44;
        const y = s.y + (s.lines.length - 1) * s.size * LH + 6;
        const x0 = s.anchor === 'middle' ? s.x - w / 2 : s.x;
        g.appendChild(rc.line(x0, y, x0 + w, y, { ...o, stroke: s.color === 'red' ? RED : INK }));
      }
      void t;
      break;
    }
    case 'bar':
      g.appendChild(rc.rectangle(s.x, s.y, s.w, s.h, { ...o, fill: TONES[s.tone % TONES.length], fillStyle: 'hachure', hachureGap: 5, fillWeight: 1.4 }));
      break;
    case 'circle':
      g.appendChild(rc.circle(s.x, s.y, s.r * 2, { ...o, stroke: RED }));
      textBlock(g, { x: s.x, y: s.y + 5, lines: [s.label], size: 15, fill: RED });
      break;
    case 'divider':
      g.appendChild(rc.line(s.x, s.y1, s.x, s.y2, { ...o, stroke: DIM, strokeWidth: 1, roughness: 1.6 }));
      textBlock(g, { x: s.x, y: s.y1 - 2, lines: ['vs'], size: 15, fill: DIM });
      break;
  }
}

// Draws strokes in, one after another, then fades the handwriting in.
function animate(groups) {
  let delay = 0;
  for (const g of groups) {
    for (const p of g.querySelectorAll('path')) {
      const len = p.getTotalLength();
      if (!len) continue;
      p.style.strokeDasharray = `${len}`;
      p.style.strokeDashoffset = `${len}`;
      p.style.transition = `stroke-dashoffset ${Math.min(0.7, 0.18 + len / 900)}s ease-in-out ${delay}s`;
      delay += 0.035;
      requestAnimationFrame(() => requestAnimationFrame(() => (p.style.strokeDashoffset = '0')));
    }
    for (const t of g.querySelectorAll('text')) {
      t.classList.add('wb-write');
      t.style.animationDelay = `${delay}s`;
    }
    delay += 0.12;
  }
}

// layout: from layoutVisual/layoutMap. step: last visible step. animate: draw this step in.
export function drawWhiteboard(container, layout, { step = layout.steps - 1, animate: anim = false, seedKey = '', current } = {}) {
  container.textContent = '';
  const svg = el('svg', { viewBox: `${-layout.overflowX / 2 - 2} 0 ${layout.width + layout.overflowX + 4} ${layout.height}`, class: 'wb-svg', role: 'img' }, container);
  const rc = rough.svg(svg);
  const fresh = [];
  for (const s of layout.shapes) {
    if (s.step > step) continue;
    const g = el('g', {}, svg);
    drawShape(rc, g, s, hash(seedKey + s.id), { current });
    if (anim && s.step === step) fresh.push(g);
  }
  if (fresh.length) animate(fresh);
  return svg;
}
