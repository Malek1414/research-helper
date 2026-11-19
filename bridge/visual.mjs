// Visual mode: Claude describes pictures as small structured data (boxes, arrows,
// groups, steps); the panel draws them hand-drawn with rough.js. Claude never
// writes drawing code, so nothing it returns can run in the page.

export const VISUAL_VERSION = 1;
export const KINDS = ['flow', 'stack', 'compare', 'formula', 'analogy', 'numbers', 'cycle'];

const item = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'detail', 'icon', 'group', 'value'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    detail: { type: 'string' },
    icon: { type: 'string' },
    group: { type: 'string' },
    value: { type: 'number' },
  },
};
const link = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'label'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } },
};

export const VISUAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['map', 'sections'],
  properties: {
    map: {
      type: 'object',
      additionalProperties: false,
      required: ['nodes', 'links'],
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label', 'section'],
            properties: { id: { type: 'string' }, label: { type: 'string' }, section: { type: 'integer' } },
          },
        },
        links: { type: 'array', items: link },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'kind', 'oneLiner', 'groups', 'items', 'links', 'steps'],
        properties: {
          section: { type: 'integer' },
          kind: { type: 'string', enum: KINDS },
          oneLiner: { type: 'string' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label'],
              properties: { id: { type: 'string' }, label: { type: 'string' } },
            },
          },
          items: { type: 'array', items: item },
          links: { type: 'array', items: link },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['show', 'caption'],
              properties: { show: { type: 'array', items: { type: 'string' } }, caption: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const words = (s, n) => s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');

function cleanVisual(v) {
  const kind = KINDS.includes(v.kind) ? v.kind : 'flow';
  const maxItems = kind === 'numbers' ? 6 : 8;
  const seen = new Set();
  const items = (Array.isArray(v.items) ? v.items : [])
    .map((it, i) => ({
      id: str(it.id, 40) || `i${i}`,
      label: str(it.label, 60),
      detail: str(it.detail, 140),
      icon: str(it.icon, 8),
      group: str(it.group, 40),
      value: Number.isFinite(it.value) ? it.value : 0,
    }))
    .filter((it) => it.label && !seen.has(it.id) && seen.add(it.id))
    .slice(0, maxItems);
  if (items.length < 2) return null;
  const ids = new Set(items.map((i) => i.id));
  const groupIds = new Set(items.map((i) => i.group).filter(Boolean));
  const groups = (Array.isArray(v.groups) ? v.groups : [])
    .map((g) => ({ id: str(g.id, 40), label: str(g.label, 60) }))
    .filter((g) => g.id && g.label && groupIds.has(g.id))
    .slice(0, 3);
  const links = (Array.isArray(v.links) ? v.links : [])
    .map((l) => ({ from: str(l.from, 40), to: str(l.to, 40), label: str(l.label, 40) }))
    .filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to)
    .slice(0, 12);
  // Steps reveal items cumulatively. Every item must appear in some step.
  const shown = new Set();
  const steps = (Array.isArray(v.steps) ? v.steps : [])
    .map((s) => {
      const show = (Array.isArray(s.show) ? s.show : []).map((x) => str(x, 40)).filter((x) => ids.has(x) && !shown.has(x) && shown.add(x));
      return { show, caption: words(str(s.caption, 160), 18) };
    })
    .filter((s) => s.show.length || s.caption)
    .slice(0, 7);
  const missing = items.map((i) => i.id).filter((id) => !shown.has(id));
  if (missing.length) {
    if (steps.length) steps[steps.length - 1].show.push(...missing);
    else steps.push({ show: missing, caption: '' });
  }
  if (!steps[0].show.length && steps.length > 1) {
    steps[1].caption ||= steps[0].caption;
    steps.shift();
  }
  return { kind, oneLiner: words(str(v.oneLiner, 200), 24), groups, items, links, steps };
}

// sectionCount: how many sections the analysis has; visuals are matched by index.
export function validateVisuals(raw, sectionCount) {
  if (!raw || typeof raw !== 'object') throw new Error('visuals missing');
  const sections = Array.from({ length: sectionCount }, () => null);
  for (const v of Array.isArray(raw.sections) ? raw.sections : []) {
    const i = Number.isInteger(v?.section) ? v.section : -1;
    if (i < 0 || i >= sectionCount || sections[i]) continue;
    sections[i] = cleanVisual(v);
  }
  if (!sections.some(Boolean)) throw new Error('no usable visuals');
  const nodeSeen = new Set();
  const nodes = (Array.isArray(raw.map?.nodes) ? raw.map.nodes : [])
    .map((n) => ({ id: str(n.id, 40), label: words(str(n.label, 60), 6), section: Number.isInteger(n.section) && n.section >= 0 && n.section < sectionCount ? n.section : -1 }))
    .filter((n) => n.id && n.label && !nodeSeen.has(n.id) && nodeSeen.add(n.id))
    .slice(0, 12);
  const links = (Array.isArray(raw.map?.links) ? raw.map.links : [])
    .map((l) => ({ from: str(l.from, 40), to: str(l.to, 40), label: words(str(l.label, 40), 4) }))
    .filter((l) => nodeSeen.has(l.from) && nodeSeen.has(l.to) && l.from !== l.to)
    .slice(0, 18);
  return { map: nodes.length >= 2 ? { nodes, links } : null, sections };
}

export function visualPrompt({ aboutMe, sourceTitle, chapterTitle, sections, text }) {
  const list = sections.map((s, i) => `### Section ${i}: ${s.title} (p. ${s.page})\n${s.explanation}`).join('\n\n');
  return `Reader: ${aboutMe}

Source: "${sourceTitle}". Chapter: "${chapterTitle}".

The reader learns best from pictures, not paragraphs. The chapter was already explained in words, section by section:

<sections>
${list}
</sections>

The original chapter text, for exact names, numbers and formulas:
<chapter>
${text}
</chapter>

Turn every section into a whiteboard drawing that a tutor would sketch while talking, plus one concept map of the whole chapter. Return JSON matching the schema.

sections: one entry per section above, section = its number (0-based). For each:
- kind: the picture that explains THIS idea best:
  - flow: data or work moving through steps (A -> B -> C). Items in order; links for the arrows (label = what moves).
  - stack: layers built on each other. First item = bottom layer. value = how many times it repeats (e.g. 6), else 0.
  - compare: two things side by side (old way vs new way, before vs after). Exactly 2 groups; each item has group = a group id; put matching rows in the same order in both groups.
  - formula: an equation split into its parts. label = the part as written (e.g. "QK^T", "/ sqrt(d_k)", "softmax"), detail = what it does in plain words. Items in the order they appear in the formula.
  - analogy: an everyday scene. icon = one emoji, label = the everyday thing ("Chef"), detail = the technical thing it stands for ("Encoder: reads the whole order").
  - numbers: key results to compare. label = what, value = the number, detail = unit or context ("BLEU", "days on 8 GPUs"). 2 to 6 items with the same unit.
  - cycle: a loop that repeats (training loop, feedback). Items in loop order.
  Use different kinds across the chapter where it fits; never force one.
- items: 2 to 7 (numbers: 2 to 6). id = short unique id ("q", "k", "enc"). label: 1 to 4 words. detail: at most 12 plain words, or "". icon: one emoji or "". group: a group id for compare, else "". value: a number for stack/numbers, else 0.
- groups: for compare, exactly 2 ({id, label}); otherwise [].
- links: arrows between item ids, with a 1-3 word label or "". For flow and cycle give the arrows explicitly. Otherwise [] unless an arrow really helps.
- steps: 2 to 5 steps that build the picture up like a tutor drawing it. show = the item ids that appear at this step (each id in exactly one step). caption = what the tutor says at this step, at most 14 words, plain and concrete, no jargon left undefined.
- oneLiner: the whole idea in at most 16 words.

map: the chapter's main ideas as a concept map, 4 to 10 nodes. id short and unique, label 1 to 4 words, section = the section number where the idea is explained (or -1). links: how the ideas connect, label 1 to 3 words ("feeds", "replaces", "made of", "needs"). It should read top-down from the big idea to its parts.

Keep every label short: they are drawn by hand in a narrow panel. No em dashes.`;
}
