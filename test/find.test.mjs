import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abstractFromIndex, pdfUrlFromWork, rankPapers, parseArxiv, toPaper } from '../plugin/scripts/find.mjs';

test('abstract is rebuilt from the inverted index', () => {
  assert.equal(abstractFromIndex({ attention: [1], is: [2], Self: [0] }), 'Self attention is');
  assert.equal(abstractFromIndex(null), '');
  assert.equal(abstractFromIndex({ a: [0], b: [1], c: [2] }, 2), 'a b…');
});

test('pdf link prefers arXiv, then any open pdf', () => {
  assert.equal(pdfUrlFromWork({ best_oa_location: { pdf_url: 'https://x.org/a.pdf' }, locations: [{ landing_page_url: 'http://arxiv.org/abs/1706.03762v7' }] }), 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(pdfUrlFromWork({ best_oa_location: { pdf_url: 'https://x.org/a.pdf' } }), 'https://x.org/a.pdf');
  assert.equal(pdfUrlFromWork({ primary_location: { landing_page_url: 'https://x.org/abs' } }), null);
});

test('ranking drops papers without a pdf and blends relevance with citations', () => {
  const papers = [
    { title: 'fit', citations: 10, pdf: 'a', year: 2024 },
    { title: 'none', citations: 99999, pdf: null, year: 2020 },
    { title: 'classic', citations: 50000, pdf: 'b', year: 2017 },
    { title: 'weak', citations: 1, pdf: 'c', year: 2025 },
  ];
  assert.deepEqual(rankPapers(papers).map((p) => p.title), ['classic', 'fit', 'weak']);
  assert.deepEqual(rankPapers(papers, 'recent').map((p) => p.title), ['weak', 'fit', 'classic']);
  assert.equal(toPaper({ display_name: 'T', authorships: [], cited_by_count: 3 }).citations, 3);
});

test('arXiv atom feed is parsed', () => {
  const xml = `<feed><entry><id>http://arxiv.org/abs/2401.04088v1</id><published>2024-01-08T00:00:00Z</published>
    <title>Mixtral of
     Experts</title><summary>We introduce Mixtral.</summary><author><name>Albert Q. Jiang</name></author></entry></feed>`;
  const [p] = parseArxiv(xml);
  assert.equal(p.title, 'Mixtral of Experts');
  assert.equal(p.year, 2024);
  assert.equal(p.pdf, 'https://arxiv.org/pdf/2401.04088v1');
  assert.deepEqual(p.authors, ['Albert Q. Jiang']);
});
