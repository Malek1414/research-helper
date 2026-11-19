import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitChapters, chaptersFromOutline, detectHeadings, fixedChunks } from '../extension/shared/chapters.js';

test('small doc without outline is one chapter', () => {
  assert.deepEqual(splitChapters({ outline: [], headings: [], numPages: 12 }), [
    { title: 'Whole document', start: 0, end: 11 },
  ]);
});

test('small doc stays one chapter even with an outline', () => {
  const outline = [{ title: 'Intro', page: 1, children: [] }, { title: 'Method', page: 3, children: [] }];
  assert.deepEqual(splitChapters({ outline, headings: [], numPages: 15 }), [{ title: 'Whole document', start: 0, end: 14 }]);
});

test('outline items on the same page are merged into one title', () => {
  const outline = [
    { title: 'Intro', page: 2, children: [] }, { title: 'Background', page: 2, children: [] },
    { title: 'Model', page: 40, children: [] },
  ];
  assert.deepEqual(chaptersFromOutline(outline, 80).map((c) => c.title), ['Front matter', 'Intro · Background', 'Model']);
});

test('outline top-level items become chapters with front matter', () => {
  const outline = [
    { title: 'Reliable, Scalable', page: 4, children: [] },
    { title: 'Data Models', page: 30, children: [] },
    { title: 'Storage', page: 70, children: [] },
  ];
  assert.deepEqual(chaptersFromOutline(outline, 100), [
    { title: 'Front matter', start: 0, end: 3 },
    { title: 'Reliable, Scalable', start: 4, end: 29 },
    { title: 'Data Models', start: 30, end: 69 },
    { title: 'Storage', start: 70, end: 99 },
  ]);
});

test('single top-level outline item uses its children', () => {
  const outline = [{ title: 'Book', page: 0, children: [
    { title: 'One', page: 0, children: [] },
    { title: 'Two', page: 20, children: [] },
  ] }];
  assert.deepEqual(chaptersFromOutline(outline, 40).map((c) => c.title), ['One', 'Two']);
});

test('chapters over 60 pages split by children, else fixed chunks', () => {
  const outline = [
    { title: 'Huge', page: 0, children: [
      { title: 'Huge A', page: 0, children: [] },
      { title: 'Huge B', page: 40, children: [] },
    ] },
    { title: 'Long', page: 90, children: [] },
  ];
  const ch = chaptersFromOutline(outline, 170);
  assert.deepEqual(ch.map((c) => c.title), [
    'Huge A', 'Huge B', 'Long (pp 91-105)', 'Long (pp 106-120)', 'Long (pp 121-135)',
    'Long (pp 136-150)', 'Long (pp 151-165)', 'Long (pp 166-170)',
  ]);
  assert.equal(ch.at(-1).end, 169);
});

test('outline with unresolved pages or one item falls through to headings', () => {
  const headings = [{ page: 2, title: 'Chapter 1 Intro' }, { page: 30, title: 'Chapter 2 More' }];
  const ch = splitChapters({ outline: [{ title: 'x', page: null, children: [] }], headings, numPages: 50 });
  assert.deepEqual(ch, [
    { title: 'Front matter', start: 0, end: 1 },
    { title: 'Chapter 1 Intro', start: 2, end: 29 },
    { title: 'Chapter 2 More', start: 30, end: 49 },
  ]);
});

test('no structure on a long doc gives 15 page chunks', () => {
  const ch = splitChapters({ outline: [], headings: [], numPages: 40 });
  assert.deepEqual(ch.map((c) => [c.start, c.end]), [[0, 14], [15, 29], [30, 39]]);
  assert.equal(ch[0].title, 'Pages 1-15');
  assert.deepEqual(fixedChunks(0), []);
});

test('detectHeadings finds big "Chapter N" lines', () => {
  const body = { text: 'some ordinary body text here', size: 10, y: 0.5 };
  const pages = [
    { page: 0, lines: [body, body] },
    { page: 1, lines: [{ text: 'Chapter 3', size: 24, y: 0.15 }, body, body] },
    { page: 2, lines: [{ text: 'Big but not a heading sentence that is long', size: 24, y: 0.1 }, body] },
    { page: 3, lines: [body, { text: 'Chapter 4', size: 14, y: 0.6 }] },
  ];
  assert.deepEqual(detectHeadings(pages), [{ page: 1, title: 'Chapter 3' }, { page: 3, title: 'Chapter 4' }]);
});

test('detectHeadings follows a numbered sequence and skips noise', () => {
  const body = { text: 'body text of the paper goes here', size: 10, y: 0.5 };
  const h = (text, y = 0.5, size = 12) => ({ text, size, y });
  const pages = [
    { page: 0, lines: [body, h('1 INTRODUCTION', 0.7)] },
    { page: 1, lines: [body, h('2.1 Subsection', 0.3), h('3 apples were on the table.', 0.4, 12)] },
    { page: 2, lines: [body, h('2 OVERVIEW'), body] },
    { page: 3, lines: [body, h('7 Something Out Of Order')] },
    { page: 4, lines: [h('3 Resources of LLMs', 0.9), body] },
    { page: 5, lines: [body, h('4 Small Font Heading', 0.2, 10)] },
  ];
  assert.deepEqual(detectHeadings(pages), [
    { page: 0, title: '1 INTRODUCTION' },
    { page: 2, title: '2 OVERVIEW' },
    { page: 4, title: '3 Resources of LLMs' },
  ]);
});
