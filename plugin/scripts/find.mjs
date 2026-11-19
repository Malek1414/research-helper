#!/usr/bin/env node
// Finds open-access papers to read, by topic or by researcher, using OpenAlex
// (citations, venues, open PDFs) and arXiv (recent preprints). No API key, no deps.
//
//   node find.mjs topic "vector databases" [--n 10] [--since 2015] [--sort relevance|citations|recent] [--json]
//   node find.mjs author "Yann LeCun" [--topic "self-supervised"] [--n 10] [--json]
//   node find.mjs arxiv "mixture of experts" [--n 10] [--json]

const OPENALEX = 'https://api.openalex.org';
const UA = { 'user-agent': 'ResearchHelper/0.1 (paper finder)' };
const SELECT = 'id,display_name,publication_year,authorships,cited_by_count,primary_location,best_oa_location,locations,abstract_inverted_index,type,doi';

export function abstractFromIndex(index, words = 60) {
  if (!index) return '';
  const pos = [];
  for (const [w, at] of Object.entries(index)) for (const i of at) pos[i] = w;
  const text = pos.filter(Boolean).slice(0, words).join(' ');
  return pos.filter(Boolean).length > words ? `${text}…` : text;
}

const arxivPdf = (u) => {
  const m = String(u || '').match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#]|$)/i);
  return m ? `https://arxiv.org/pdf/${m[1]}` : null;
};

export function pdfUrlFromWork(w) {
  const locs = [w.best_oa_location, w.primary_location, ...(w.locations || [])].filter(Boolean);
  for (const l of locs) {
    const a = arxivPdf(l.pdf_url) || arxivPdf(l.landing_page_url);
    if (a) return a; // arXiv links are the most reliable direct PDFs
  }
  for (const l of locs) if (l.pdf_url) return l.pdf_url;
  return null;
}

export function toPaper(w) {
  return {
    title: w.display_name,
    year: w.publication_year,
    authors: (w.authorships || []).slice(0, 4).map((a) => a.author?.display_name).filter(Boolean),
    moreAuthors: Math.max(0, (w.authorships || []).length - 4),
    venue: w.primary_location?.source?.display_name || '',
    citations: w.cited_by_count || 0,
    type: w.type,
    pdf: pdfUrlFromWork(w),
    doi: w.doi || '',
    abstract: abstractFromIndex(w.abstract_inverted_index),
  };
}

// Blends search relevance (result order) with citations so classics surface without burying fit.
export function rankPapers(papers, sort = 'relevance') {
  const withPdf = papers.filter((p) => p.pdf);
  if (sort === 'citations') return withPdf.sort((a, b) => b.citations - a.citations);
  if (sort === 'recent') return withPdf.sort((a, b) => (b.year || 0) - (a.year || 0) || b.citations - a.citations);
  const n = withPdf.length || 1;
  const maxLog = Math.max(1, ...withPdf.map((p) => Math.log10(p.citations + 1)));
  return withPdf
    .map((p, i) => ({ p, s: 0.55 * (1 - i / n) + 0.45 * (Math.log10(p.citations + 1) / maxLog) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

export function parseArxiv(xml) {
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const id = tag(e, 'id');
    return {
      title: tag(e, 'title'),
      year: Number(tag(e, 'published').slice(0, 4)) || null,
      authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 4).map((m) => m[1].trim()),
      moreAuthors: Math.max(0, [...e.matchAll(/<name>/g)].length - 4),
      venue: 'arXiv',
      citations: null,
      type: 'preprint',
      pdf: arxivPdf(id),
      doi: '',
      abstract: tag(e, 'summary').split(' ').slice(0, 60).join(' ') + '…',
    };
  });
}

// Without a key OpenAlex gives a small free daily budget shared per IP address.
// A free key (https://openalex.org/settings/api) gives $1/day of its own: export OPENALEX_API_KEY=...
const withKey = (url) => (process.env.OPENALEX_API_KEY && url.startsWith(OPENALEX) ? `${url}&api_key=${process.env.OPENALEX_API_KEY}` : url);

async function getJson(url, tries = 4) {
  url = withKey(url);
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      const wait = Number(r.headers.get('retry-after')) * 1000 || 1500 * 2 ** i;
      await new Promise((res) => setTimeout(res, Math.min(wait, 10000)));
      continue;
    }
    throw new Error(`${new URL(url).host} answered ${r.status}${r.status === 429 && !process.env.OPENALEX_API_KEY ? ' (shared free budget used up; set OPENALEX_API_KEY for your own)' : ''}`);
  }
}

export async function byTopic(query, { n = 10, since, sort = 'relevance' } = {}) {
  const filter = ['open_access.is_oa:true', since && `from_publication_date:${since}-01-01`].filter(Boolean).join(',');
  const url = `${OPENALEX}/works?search=${encodeURIComponent(query)}&filter=${filter}&per-page=25&select=${SELECT}`;
  const { results } = await getJson(url);
  return rankPapers(results.map(toPaper), sort).slice(0, n);
}

export async function byAuthor(name, { n = 10, topic } = {}) {
  const { results } = await getJson(`${OPENALEX}/authors?search=${encodeURIComponent(name)}&per-page=6&select=id,display_name,works_count,cited_by_count,last_known_institutions,topics`);
  if (!results.length) return { candidates: [], papers: [] };
  const candidates = results
    .map((a) => ({
      id: a.id.split('/').pop(),
      name: a.display_name,
      works: a.works_count,
      citations: a.cited_by_count,
      institution: a.last_known_institutions?.[0]?.display_name || '',
      topics: (a.topics || []).slice(0, 3).map((t) => t.display_name),
    }))
    .sort((a, b) => b.citations - a.citations);
  const pick = candidates[0];
  const search = topic ? `&search=${encodeURIComponent(topic)}` : '';
  const { results: works } = await getJson(`${OPENALEX}/works?filter=authorships.author.id:${pick.id},open_access.is_oa:true${search}&sort=cited_by_count:desc&per-page=30&select=${SELECT}`);
  return { author: pick, candidates, papers: works.map(toPaper).filter((p) => p.pdf).slice(0, n) };
}

export async function byArxiv(query, { n = 10 } = {}) {
  const terms = query.split(/\s+/).filter((w) => w.length > 1).map((w) => `all:${w.replace(/[^\w-]/g, '')}`).join(' AND ');
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(terms)}&sortBy=relevance&max_results=${n}`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`arXiv answered ${r.status}`);
  return parseArxiv(await r.text());
}

function show(p, i) {
  const authors = p.authors.join(', ') + (p.moreAuthors ? ` +${p.moreAuthors}` : '');
  return [
    `${i + 1}. ${p.title} (${p.year ?? '?'})`,
    `   ${authors}${p.venue ? ` · ${p.venue}` : ''}${p.citations != null ? ` · ${p.citations.toLocaleString('en')} citations` : ''}`,
    `   PDF: ${p.pdf}`,
    p.abstract ? `   ${p.abstract}` : '',
  ].filter(Boolean).join('\n');
}

async function main() {
  const [mode, query, ...rest] = process.argv.slice(2);
  const opt = (k, d) => {
    const i = rest.indexOf(`--${k}`);
    return i >= 0 ? rest[i + 1] : d;
  };
  const json = rest.includes('--json');
  const n = Number(opt('n', 10));
  if (!query || !['topic', 'author', 'arxiv'].includes(mode)) {
    console.error('usage: find.mjs topic|author|arxiv "<query>" [--n 10] [--since 2015] [--sort relevance|citations|recent] [--topic "..."] [--json]');
    process.exit(1);
  }
  if (mode === 'author') {
    const res = await byAuthor(query, { n, topic: opt('topic') });
    if (json) return console.log(JSON.stringify(res, null, 2));
    if (!res.candidates.length) return console.log(`No researcher found for "${query}".`);
    const a = res.author;
    console.log(`Researcher: ${a.name}${a.institution ? `, ${a.institution}` : ''} · ${a.works} works · ${a.citations.toLocaleString('en')} citations · ${a.topics.join(', ')}`);
    const others = res.candidates.slice(1).filter((c) => c.citations > a.citations * 0.05);
    if (others.length) console.log(`Other people with this name: ${others.map((c) => `${c.name} (${c.institution || 'unknown'}, ${c.citations} cit.)`).join('; ')}`);
    console.log(`\nMost cited open-access papers${opt('topic') ? ` on "${opt('topic')}"` : ''}:\n`);
    console.log(res.papers.map(show).join('\n\n') || 'None with a free PDF.');
    return;
  }
  let papers;
  if (mode === 'topic') {
    try {
      papers = await byTopic(query, { n, since: opt('since'), sort: opt('sort', 'relevance') });
    } catch (e) {
      console.error(`OpenAlex unavailable (${e.message}); showing arXiv results instead (no citation counts).`);
      papers = await byArxiv(query, { n });
    }
  } else papers = await byArxiv(query, { n });
  if (json) return console.log(JSON.stringify(papers, null, 2));
  console.log(papers.map(show).join('\n\n') || 'Nothing with a free PDF. Try other words, or `arxiv` mode.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`find failed: ${e.message}`);
    process.exit(1);
  });
}
