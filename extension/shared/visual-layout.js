// Turns a visual description from Claude ({kind, items, groups, links, steps}) or a
// concept map ({nodes, links}) into positioned shapes. Pure: no DOM, no rough.js,
// so it is unit-tested in Node. The panel's whiteboard.js draws the result.
//
// Shapes:
//   {type:'box',   id, x, y, w, h, lines, sub, icon, tone, mono, reveal}
//   {type:'text',  id, x, y, lines, size, anchor, color, mono, reveal}
//   {type:'arrow', id, points:[[x,y]...], label, lx, ly, reveal:[ids]}
//   {type:'bar',   id, x, y, w, h, tone, reveal}
// reveal = item id(s) whose step makes the shape appear.

export const W = 400;
const PAD = 16;
export const FONT = 19; // Caveat, label size
export const SUB = 15; // Caveat, detail size

// Caveat is narrow; about 0.44em per character on average (mono ~0.6em).
export const measure = (s, size, mono = false) => s.length * size * (mono ? 0.6 : 0.44);

export function wrap(text, maxW, size, mono = false) {
  const out = [];
  let line = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size, mono) > maxW) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

const lineH = (size) => size * 1.12;

function box(id, x, y, w, { label, detail = '', icon = '', tone = 0, mono = false, reveal = id, minH = 0 }) {
  const inner = w - 20 - (icon ? 30 : 0);
  const lines = wrap(label, inner, FONT, mono);
  const sub = detail ? wrap(detail, inner, SUB) : [];
  const h = Math.max(minH, 16 + lines.length * lineH(FONT) + (sub.length ? 4 + sub.length * lineH(SUB) : 0));
  return { type: 'box', id, x, y, w, h, lines, sub, icon, tone, mono, reveal };
}

function arrow(id, points, label, reveal, side = 'right') {
  const [a, b] = [points[0], points[points.length - 1]];
  const mid = points.length > 2 ? points[1] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const vertical = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
  return {
    type: 'arrow', id, points, label: label || '',
    lx: vertical ? mid[0] + (side === 'right' ? 10 : -10) : mid[0],
    ly: vertical ? mid[1] + 5 : mid[1] - 8,
    anchor: vertical ? (side === 'right' ? 'start' : 'end') : 'middle',
    reveal,
  };
}

const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];

// Arrow between two boxes, from the edge facing the other box.
function connect(id, a, b, label) {
  const [ax, ay] = center(a);
  const [bx, by] = center(b);
  let p1, p2;
  if (Math.abs(by - ay) > Math.abs(bx - ax) * 0.6) {
    p1 = [ax, by > ay ? a.y + a.h + 3 : a.y - 3];
    p2 = [bx, by > ay ? b.y - 5 : b.y + b.h + 5];
  } else {
    p1 = [bx > ax ? a.x + a.w + 3 : a.x - 3, ay];
    p2 = [bx > ax ? b.x - 5 : b.x + b.w + 5, by];
  }
  return arrow(id, [p1, p2], label, [a.reveal, b.reveal].flat());
}

function defaultLinks(items) {
  return items.slice(1).map((it, i) => ({ from: items[i].id, to: it.id, label: '' }));
}

// ---------- kinds ----------

function flow(v) {
  const items = v.items;
  const links = v.links.length ? v.links : defaultLinks(items);
  const shapes = [];
  const n = items.length;
  const colW = (W - 2 * PAD - (n - 1) * 26) / n;
  const fitsRow = n <= 3 && items.every((it) => wrap(it.label, colW - 20, FONT).length <= 2 && !it.detail);
  const boxes = {};
  if (fitsRow) {
    items.forEach((it, i) => (boxes[it.id] = box(it.id, PAD + i * (colW + 26), 30, colW, { label: it.label, icon: it.icon, tone: i, minH: 62 })));
  } else {
    let y = 12;
    const bw = 250;
    items.forEach((it, i) => {
      const b = box(it.id, (W - bw) / 2 - 30, y, bw, { label: it.label, detail: it.detail, icon: it.icon, tone: i });
      boxes[it.id] = b;
      y += b.h + 44;
    });
  }
  const order = items.map((i) => i.id);
  for (const [k, l] of links.entries()) {
    const a = boxes[l.from];
    const b = boxes[l.to];
    if (!a || !b) continue;
    const adjacent = order.indexOf(l.to) - order.indexOf(l.from) === 1;
    if (fitsRow || adjacent) shapes.push(connect(`l${k}`, a, b, l.label));
    else {
      // Non-neighbours: loop around the right-hand side.
      const x = Math.max(a.x + a.w, b.x + b.w) + 28 + (k % 3) * 8;
      const [, ay] = center(a);
      const [, by] = center(b);
      shapes.push(arrow(`l${k}`, [[a.x + a.w + 3, ay], [x, (ay + by) / 2], [b.x + b.w + 5, by]], l.label, [l.from, l.to]));
    }
  }
  return [...Object.values(boxes), ...shapes];
}

function stack(v) {
  const shapes = [];
  const bw = 270;
  const x = (W - bw) / 2 - 20;
  // First item is the bottom layer: lay out top-down from the last item.
  const rev = [...v.items].reverse();
  let y = 12;
  rev.forEach((it, i) => {
    const b = box(it.id, x, y, bw, { label: it.label, detail: it.detail, icon: it.icon, tone: v.items.length - 1 - i });
    shapes.push(b);
    if (it.value > 1) shapes.push({ type: 'text', id: `${it.id}-x`, x: x + bw + 12, y: y + b.h / 2 + 7, lines: [`×${Math.round(it.value)}`], size: 24, anchor: 'start', color: 'red', reveal: it.id });
    y += b.h + 8;
  });
  return shapes;
}

function compare(v) {
  const groups = v.groups.length >= 2 ? v.groups.slice(0, 2) : [{ id: 'a', label: '' }, { id: 'b', label: '' }];
  const cols = [[], []];
  v.items.forEach((it, i) => {
    const gi = groups.findIndex((g) => g.id === it.group);
    cols[gi >= 0 ? gi : i % 2].push(it);
  });
  const colW = (W - 2 * PAD - 24) / 2;
  const xs = [PAD, PAD + colW + 24];
  const shapes = [];
  let top = 10;
  if (groups.some((g) => g.label)) {
    const heads = groups.map((g, gi) => wrap(g.label, colW, 22));
    const hh = Math.max(...heads.map((h) => h.length)) * lineH(22);
    groups.forEach((g, gi) => {
      const first = cols[gi][0];
      shapes.push({ type: 'text', id: `g${gi}`, x: xs[gi] + colW / 2, y: top + 20, lines: heads[gi], size: 22, anchor: 'middle', color: gi ? 'red' : 'ink', underline: true, reveal: first?.id || '' });
    });
    top += hh + 22;
  }
  const rows = Math.max(cols[0].length, cols[1].length);
  let y = top;
  for (let r = 0; r < rows; r++) {
    const pair = [0, 1].map((c) => cols[c][r] && box(cols[c][r].id, xs[c], y, colW, { label: cols[c][r].label, detail: cols[c][r].detail, icon: cols[c][r].icon, tone: c ? 3 : 0 }));
    const h = Math.max(...pair.filter(Boolean).map((b) => b.h));
    pair.forEach((b) => b && ((b.h = h), shapes.push(b)));
    y += h + 10;
  }
  shapes.push({ type: 'divider', id: 'vs', x: W / 2, y1: top - 4, y2: y - 6, reveal: [] });
  return shapes;
}

function formula(v) {
  const shapes = [];
  // The formula itself, built up token by token along the top.
  let x = PAD;
  let y = 18;
  const size = 21;
  const tokens = [];
  for (const it of v.items) {
    const w = measure(it.label, size, true) + 14;
    if (x + w > W - PAD && x > PAD) {
      x = PAD;
      y += 38;
    }
    tokens.push({ it, x, y, w });
    x += w + 6;
  }
  // Centre each formula line.
  for (const ly of [...new Set(tokens.map((t) => t.y))]) {
    const line = tokens.filter((t) => t.y === ly);
    const width = line[line.length - 1].x + line[line.length - 1].w - line[0].x;
    const shift = (W - width) / 2 - line[0].x;
    line.forEach((t) => (t.x += shift));
  }
  tokens.forEach((t, i) => shapes.push({ type: 'box', id: `t-${t.it.id}`, x: t.x, y: t.y, w: t.w, h: 32, lines: [t.it.label], sub: [], icon: '', tone: i, mono: true, bare: true, reveal: t.it.id }));
  // Each part explained underneath: numbered marker, part, meaning.
  y += 58;
  v.items.forEach((it, i) => {
    const t = tokens[i];
    const tag = `${i + 1}`;
    shapes.push({ type: 'text', id: `n-${it.id}`, x: t.x + t.w / 2, y: t.y - 6, lines: [tag], size: 14, anchor: 'middle', color: 'red', reveal: it.id });
    const lines = wrap(it.detail || it.label, W - 2 * PAD - 44, SUB + 2);
    shapes.push({ type: 'text', id: `m-${it.id}`, x: PAD + 30, y: y + 2, lines, size: SUB + 2, anchor: 'start', color: 'ink', reveal: it.id });
    shapes.push({ type: 'circle', id: `c-${it.id}`, x: PAD + 11, y: y - 4, r: 11, label: tag, reveal: it.id });
    y += Math.max(28, lines.length * lineH(SUB + 2) + 12);
  });
  return shapes;
}

function analogy(v) {
  const shapes = [];
  let y = 10;
  const leftW = 150;
  v.items.forEach((it, i) => {
    const b = box(it.id, PAD, y, leftW, { label: it.label, icon: it.icon, tone: i });
    const lines = wrap(it.detail, W - PAD - (PAD + leftW + 46), SUB + 2);
    const h = Math.max(b.h, lines.length * lineH(SUB + 2) + 14);
    b.h = h;
    shapes.push(b);
    shapes.push(arrow(`a-${it.id}`, [[PAD + leftW + 6, y + h / 2], [PAD + leftW + 36, y + h / 2]], '', [it.id]));
    shapes.push({ type: 'text', id: `d-${it.id}`, x: PAD + leftW + 44, y: y + h / 2 - ((lines.length - 1) * lineH(SUB + 2)) / 2 + 5, lines, size: SUB + 2, anchor: 'start', color: 'ink', reveal: it.id });
    y += h + 12;
  });
  return shapes;
}

function numbers(v) {
  const shapes = [];
  const max = Math.max(...v.items.map((i) => Math.abs(i.value)), 1e-9);
  const barMax = W - 2 * PAD - 70;
  let y = 8;
  v.items.forEach((it, i) => {
    const lines = wrap(it.label + (it.detail ? ` · ${it.detail}` : ''), W - 2 * PAD, SUB + 1);
    shapes.push({ type: 'text', id: `l-${it.id}`, x: PAD, y: y + 15, lines, size: SUB + 1, anchor: 'start', color: 'ink', reveal: it.id });
    y += lines.length * lineH(SUB + 1) + 4;
    const w = Math.max(8, (Math.abs(it.value) / max) * barMax);
    shapes.push({ type: 'bar', id: it.id, x: PAD, y, w, h: 22, tone: i, reveal: it.id });
    shapes.push({ type: 'text', id: `v-${it.id}`, x: PAD + w + 8, y: y + 18, lines: [fmt(it.value)], size: 21, anchor: 'start', color: 'red', reveal: it.id });
    y += 34;
  });
  return shapes;
}

const fmt = (n) => (Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(2)}`);

function cycle(v) {
  const n = v.items.length;
  const bw = n > 5 ? 112 : 128;
  const rx = (W - bw) / 2 - PAD;
  const ry = n > 4 ? 120 : 92;
  const cx = W / 2;
  const cy = ry + 34;
  const boxes = v.items.map((it, i) => {
    const t = -Math.PI / 2 + (i / n) * 2 * Math.PI;
    const b = box(it.id, 0, 0, bw, { label: it.label, icon: it.icon, tone: i });
    b.x = cx + rx * Math.cos(t) - bw / 2;
    b.y = cy + ry * Math.sin(t) - b.h / 2;
    return b;
  });
  const links = v.links.length ? v.links : [...defaultLinks(v.items), { from: v.items[n - 1].id, to: v.items[0].id, label: '' }];
  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
  const arrows = links.map((l, k) => {
    const a = byId[l.from];
    const b = byId[l.to];
    if (!a || !b) return null;
    // Bow the arrow outward from the centre so it follows the loop.
    const [ax, ay] = center(a);
    const [bx, by] = center(b);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const out = 0.25;
    const ctrl = [mx + (mx - cx) * out, my + (my - cy) * out];
    const p1 = edgeToward(a, ctrl);
    const p2 = edgeToward(b, ctrl, 5);
    return arrow(`l${k}`, [p1, ctrl, p2], l.label, [l.from, l.to]);
  }).filter(Boolean);
  // Labels are placed outside the loop at the control point.
  arrows.forEach((a) => {
    const [x, y] = a.points[1];
    const d = Math.hypot(x - cx, y - cy) || 1;
    a.lx = x + ((x - cx) / d) * 16;
    a.ly = y + ((y - cy) / d) * 14 + 5;
    a.anchor = Math.abs(x - cx) < 20 ? 'middle' : x > cx ? 'start' : 'end';
  });
  return [...boxes, ...arrows];
}

function edgeToward(b, [px, py], gap = 3) {
  const [cx, cy] = center(b);
  const dx = px - cx;
  const dy = py - cy;
  const s = Math.min(Math.abs((b.w / 2 + gap) / (dx || 1e-9)), Math.abs((b.h / 2 + gap) / (dy || 1e-9)));
  return [cx + dx * s, cy + dy * s];
}

const KIND = { flow, stack, compare, formula, analogy, numbers, cycle };

// Fits the shapes into the viewBox: returns the bounding height (and shifts left
// if anything spilled past the right edge, e.g. a loop-around arrow).
function finish(shapes) {
  let maxX = 0;
  let maxY = 0;
  for (const s of shapes) {
    const pts = s.points || [[s.x + (s.w || 0), (s.y || s.y2 || 0) + (s.h || 0)]];
    for (const [x, y] of pts) {
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (s.type === 'text') maxY = Math.max(maxY, s.y + (s.lines.length - 1) * lineH(s.size) + 6);
  }
  return { width: W, height: Math.ceil(maxY + 14), overflowX: Math.max(0, maxX - W) };
}

// visual -> {width, height, shapes, steps: [[shapeIds]...]}
export function layoutVisual(v) {
  const shapes = (KIND[v.kind] || flow)(v);
  const stepOf = {};
  v.steps.forEach((s, i) => s.show.forEach((id) => (stepOf[id] = i)));
  for (const s of shapes) {
    const ids = [s.reveal].flat().filter(Boolean);
    s.step = ids.length ? Math.max(...ids.map((id) => stepOf[id] ?? 0)) : 0;
  }
  return { ...finish(shapes), shapes, steps: v.steps.length };
}

// Concept map: nodes in rows by depth (big idea on top), links between them.
export function layoutMap(map) {
  const { nodes, links } = map;
  const incoming = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  links.forEach((l) => (incoming[l.to] += 1));
  const depth = {};
  const roots = nodes.filter((n) => !incoming[n.id]);
  const queue = (roots.length ? roots : [nodes[0]]).map((n) => [n.id, 0]);
  while (queue.length) {
    const [id, d] = queue.shift();
    if (depth[id] !== undefined && depth[id] >= d) continue;
    if (d > nodes.length) continue; // cycle guard
    depth[id] = d;
    links.filter((l) => l.from === id).forEach((l) => queue.push([l.to, d + 1]));
  }
  nodes.forEach((n) => (depth[n.id] ??= 0));
  // Rows of at most 3 nodes.
  const rows = [];
  for (const d of [...new Set(Object.values(depth))].sort((a, b) => a - b)) {
    const inRow = nodes.filter((n) => depth[n.id] === d);
    for (let i = 0; i < inRow.length; i += 3) rows.push(inRow.slice(i, i + 3));
  }
  const shapes = [];
  const byId = {};
  let y = 10;
  rows.forEach((row) => {
    const gap = 14;
    const w = Math.min(170, (W - 2 * PAD - (row.length - 1) * gap) / row.length);
    const total = row.length * w + (row.length - 1) * gap;
    let x = (W - total) / 2;
    const bs = row.map((n) => {
      const b = box(n.id, x, y, w, { label: n.label, tone: depth[n.id] });
      b.section = n.section;
      x += w + gap;
      return b;
    });
    const h = Math.max(...bs.map((b) => b.h));
    bs.forEach((b) => ((b.h = h), (byId[b.id] = b), shapes.push(b)));
    y += h + 46;
  });
  links.forEach((l, k) => {
    const a = byId[l.from];
    const b = byId[l.to];
    if (a && b) shapes.push(connect(`m${k}`, a, b, l.label));
  });
  shapes.forEach((s) => (s.step = 0));
  return { ...finish(shapes), shapes, steps: 1 };
}
