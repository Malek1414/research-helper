// JSON schema Claude must answer with for a chapter, plus a checker that
// clamps and cleans what comes back before anything is cached or drawn.

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'sections', 'glossary', 'buildCard'],
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'page', 'difficulty', 'explanation', 'anchors', 'note'],
        properties: {
          title: { type: 'string' },
          page: { type: 'integer' },
          difficulty: { type: 'integer' },
          explanation: { type: 'string' },
          anchors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['page', 'quote'],
              properties: { page: { type: 'integer' }, quote: { type: 'string' } },
            },
          },
          note: { type: 'string' },
        },
      },
    },
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'definition'],
        properties: { term: { type: 'string' }, definition: { type: 'string' } },
      },
    },
    buildCard: {
      type: 'object',
      additionalProperties: false,
      required: ['coreIdea', 'whereItFits', 'sketch', 'sketchLang'],
      properties: {
        coreIdea: { type: 'string' },
        whereItFits: { type: 'array', items: { type: 'string' } },
        sketch: { type: 'string' },
        sketchLang: { type: 'string' },
      },
    },
  },
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clampInt = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);

// pageRange: [firstPage, lastPage], 1-based, inclusive.
export function validateAnalysis(raw, [first, last]) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) throw new Error('analysis has no sections');
  const sections = raw.sections
    .map((s) => {
      const page = clampInt(s.page, first, last, first);
      const difficulty = clampInt(s.difficulty, 1, 5, 3);
      const anchors = (Array.isArray(s.anchors) ? s.anchors : [])
        .map((a) => ({ page: clampInt(a.page, first, last, page), quote: str(a.quote) }))
        .filter((a) => a.quote.split(/\s+/).length >= 3)
        .slice(0, 3);
      const note = difficulty >= 4 ? str(s.note).split(/\s+/).slice(0, 14).join(' ') : '';
      return { title: str(s.title) || 'Section', page, difficulty, explanation: str(s.explanation), anchors, note };
    })
    .filter((s) => s.explanation);
  if (!sections.length) throw new Error('analysis has no usable sections');
  const bc = raw.buildCard || {};
  return {
    summary: str(raw.summary),
    sections,
    glossary: (Array.isArray(raw.glossary) ? raw.glossary : [])
      .map((g) => ({ term: str(g.term), definition: str(g.definition) }))
      .filter((g) => g.term && g.definition),
    buildCard: {
      coreIdea: str(bc.coreIdea),
      whereItFits: (Array.isArray(bc.whereItFits) ? bc.whereItFits : []).map(str).filter(Boolean),
      sketch: typeof bc.sketch === 'string' ? bc.sketch.replace(/\s+$/, '') : '',
      sketchLang: str(bc.sketchLang) || 'text',
    },
  };
}
