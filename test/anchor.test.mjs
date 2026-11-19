import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findQuote, normalize } from '../extension/shared/anchor.js';

const text = (segs, r) => {
  // Rebuild the matched original text across segments.
  let out = '';
  for (let s = r.startSeg; s <= r.endSeg; s++) {
    const a = s === r.startSeg ? r.startOff : 0;
    const b = s === r.endSeg ? r.endOff : segs[s].length;
    out += segs[s].slice(a, b) + (s < r.endSeg ? ' ' : '');
  }
  return out;
};

test('exact match inside one segment', () => {
  const segs = ['The Transformer uses ', 'self-attention to relate positions.'];
  const r = findQuote(segs, 'self-attention to relate');
  assert.equal(text(segs, r), 'self-attention to relate');
  assert.equal(r.method, 'exact');
});

test('match across segments, spacing, case and curly quotes', () => {
  const segs = ['we call it “Scaled Dot-Product', 'Attention” (Figure 2).'];
  const r = findQuote(segs, '"scaled dot-product attention"');
  assert.equal(text(segs, r), '“Scaled Dot-Product Attention”');
});

test('line-break hyphenation and ligatures', () => {
  const segs = ['efficient retrie-', 'val with eﬃcient ﬁlters'];
  assert.equal(text(segs, findQuote(segs, 'efficient retrieval with efficient filters')),
    'efficient retrie- val with eﬃcient ﬁlters');
});

test('falls back to prefix when the end of the quote is paraphrased', () => {
  const segs = ['A B-tree keeps keys sorted so range queries are fast and cheap on disk.'];
  const r = findQuote(segs, 'A B-tree keeps keys sorted so range queries stay very quick');
  assert.equal(r.method, 'prefix');
  assert.ok(text(segs, r).startsWith('A B-tree keeps keys sorted'));
});

test('falls back to suffix when the start is paraphrased', () => {
  const segs = ['Replication means keeping a copy of the same data on multiple machines.'];
  const r = findQuote(segs, 'Basically it is keeping a copy of the same data on multiple machines');
  assert.equal(r.method, 'suffix');
  assert.ok(text(segs, r).endsWith('multiple machines'));
});

test('returns null when nothing matches', () => {
  assert.equal(findQuote(['completely unrelated words'], 'gradient descent converges'), null);
  assert.equal(findQuote([''], ''), null);
});

test('normalize drops whitespace and maps back to original indices', () => {
  const { norm, map } = normalize('A  b-\nc');
  assert.equal(norm, 'abc');
  assert.deepEqual(map, [0, 3, 6]);
});
