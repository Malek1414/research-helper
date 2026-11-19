import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../extension/shared/md.js';

test('renders paragraphs, emphasis and inline code', () => {
  assert.equal(renderMarkdown('A **key** idea with `code_x` and *soft* words.\n\nNext.'),
    '<p>A <strong>key</strong> idea with <code>code_x</code> and <em>soft</em> words.</p><p>Next.</p>');
});

test('escapes HTML everywhere', () => {
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)> `<b>`'), '<p>&lt;img src=x onerror=alert(1)&gt; <code>&lt;b&gt;</code></p>');
  assert.equal(renderMarkdown('```js\n<script>\n```'), '<pre><code>&lt;script&gt;</code></pre>');
});

test('lists and headings', () => {
  assert.equal(renderMarkdown('Intro\n- one\n- two\n1. a\n2. b\n## Head'),
    '<p>Intro</p><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol><p><strong>Head</strong></p>');
});
