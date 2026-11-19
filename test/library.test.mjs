import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progress, nextInRotation, nextUnfinished, mergeGlossary } from '../extension/shared/library.js';

const src = (id, done, chapter = 0) => ({ id, title: id, chapter, chapters: done.map((d) => ({ done: d })) });

test('progress counts done chapters', () => {
  assert.deepEqual(progress(src('a', [true, false, true, false])), { done: 2, total: 4, pct: 50 });
  assert.deepEqual(progress({ id: 'x' }), { done: 0, total: 0, pct: 0 });
});

test('nextUnfinished wraps from the given chapter', () => {
  assert.equal(nextUnfinished(src('a', [false, true, true]), 1), 0);
  assert.equal(nextUnfinished(src('a', [true, true])), -1);
});

test('rotation goes to the next source with unfinished chapters', () => {
  const sources = [src('a', [true, false], 1), src('b', [true, true]), src('c', [false, false], 1)];
  assert.deepEqual(nextInRotation(sources, 'a'), { sourceId: 'c', chapter: 1 });
  assert.deepEqual(nextInRotation(sources, 'c'), { sourceId: 'a', chapter: 1 });
});

test('rotation stays on the active source when it is the only one left', () => {
  const sources = [src('a', [false, false, true], 0), src('b', [true])];
  assert.deepEqual(nextInRotation(sources, 'a'), { sourceId: 'a', chapter: 1 });
  assert.equal(nextInRotation([src('a', [true])], 'a'), null);
});

test('rotation opens a source that has not been split yet', () => {
  assert.deepEqual(nextInRotation([src('a', [false]), { id: 'new', title: 'new' }], 'a'), { sourceId: 'new', chapter: 0 });
});

test('glossary merges terms case-insensitively and tracks sources', () => {
  let g = mergeGlossary({}, [{ term: 'B-tree', definition: 'sorted tree index' }], 'DDIA');
  g = mergeGlossary(g, [{ term: 'b-tree', definition: 'other' }, { term: ' ', definition: 'x' }], 'Paper');
  assert.deepEqual(g, { 'b-tree': { term: 'B-tree', definition: 'sorted tree index', sources: ['DDIA', 'Paper'] } });
});
