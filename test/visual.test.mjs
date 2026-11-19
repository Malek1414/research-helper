import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVisuals, KINDS } from '../bridge/visual.mjs';
import { layoutVisual, layoutMap, wrap, W } from '../extension/shared/visual-layout.js';

const it = (id, extra = {}) => ({ id, label: `Label ${id}`, detail: '', icon: '', group: '', value: 0, ...extra });
const vis = (kind, items, extra = {}) => ({ section: 0, kind, oneLiner: 'x', groups: [], items, links: [], steps: [{ show: items.map((i) => i.id), caption: 'all' }], ...extra });

test('validateVisuals keeps sections by index, fills missing with null', () => {
  const raw = { map: { nodes: [], links: [] }, sections: [vis('flow', [it('a'), it('b')]), { ...vis('stack', [it('c'), it('d')]), section: 2 }, { ...vis('flow', [it('e')]), section: 1 }] };
  const v = validateVisuals(raw, 3);
  assert.equal(v.sections.length, 3);
  assert.equal(v.sections[0].kind, 'flow');
  assert.equal(v.sections[1], null); // one item is not a picture
  assert.equal(v.sections[2].kind, 'stack');
  assert.equal(v.map, null);
});

test('validateVisuals puts unshown items into the last step and drops bad links', () => {
  const raw = { map: { nodes: [{ id: 'x', label: 'X', section: 0 }, { id: 'y', label: 'Y', section: 9 }], links: [{ from: 'x', to: 'y', label: 'has' }, { from: 'x', to: 'nope', label: '' }] },
    sections: [{ ...vis('flow', [it('a'), it('b'), it('c')]), links: [{ from: 'a', to: 'b', label: '' }, { from: 'a', to: 'zz', label: '' }], steps: [{ show: ['a', 'a'], caption: 'one' }, { show: ['b'], caption: 'two' }] }] };
  const v = validateVisuals(raw, 1);
  assert.deepEqual(v.sections[0].steps.map((s) => s.show), [['a'], ['b', 'c']]);
  assert.equal(v.sections[0].links.length, 1);
  assert.equal(v.map.links.length, 1);
  assert.equal(v.map.nodes[1].section, -1);
});

test('validateVisuals throws when nothing is drawable', () => {
  assert.throws(() => validateVisuals({ sections: [] }, 2));
});

test('wrap breaks long labels', () => {
  const lines = wrap('a fairly long label that will not fit in a small box', 100, 19);
  assert.ok(lines.length > 2);
  assert.equal(lines.join(' '), 'a fairly long label that will not fit in a small box');
});

for (const kind of KINDS) {
  test(`layout ${kind}: shapes inside the board, steps assigned`, () => {
    const items = kind === 'compare'
      ? [it('a', { group: 'old' }), it('b', { group: 'new' }), it('c', { group: 'old', detail: 'some detail words here' }), it('d', { group: 'new' })]
      : [it('a', { value: 3, detail: 'what it does in plain words' }), it('b', { value: 6, icon: '🍳' }), it('c', { value: 1 }), it('d', { value: 12 })];
    const v = validateVisuals({ sections: [vis(kind, items, { groups: [{ id: 'old', label: 'Old way' }, { id: 'new', label: 'New way' }], steps: [{ show: ['a', 'b'], caption: 's1' }, { show: ['c', 'd'], caption: 's2' }] })] }, 1).sections[0];
    const L = layoutVisual(v);
    assert.equal(L.steps, 2);
    assert.ok(L.height > 40 && L.height < 1400, `height ${L.height}`);
    for (const s of L.shapes) {
      if (s.type === 'box' || s.type === 'bar') {
        assert.ok(s.x >= -1 && s.x + s.w <= W + 1, `${kind} ${s.id} x ${s.x} w ${s.w}`);
        assert.ok(s.y >= 0, `${kind} ${s.id} y`);
      }
      assert.ok(s.step === 0 || s.step === 1);
    }
    assert.ok(L.shapes.some((s) => s.step === 1));
  });
}

test('layoutMap puts the big idea above its parts', () => {
  const L = layoutMap({ nodes: [{ id: 't', label: 'Transformer', section: 0 }, { id: 'e', label: 'Encoder', section: 3 }, { id: 'd', label: 'Decoder', section: 3 }, { id: 'a', label: 'Attention', section: 4 }],
    links: [{ from: 't', to: 'e', label: 'has' }, { from: 't', to: 'd', label: 'has' }, { from: 'e', to: 'a', label: 'uses' }] });
  const y = Object.fromEntries(L.shapes.filter((s) => s.type === 'box').map((s) => [s.id, s.y]));
  assert.ok(y.t < y.e && y.e === y.d && y.d < y.a);
  assert.equal(L.shapes.filter((s) => s.type === 'arrow').length, 3);
});

test('layoutMap survives cycles', () => {
  const L = layoutMap({ nodes: [{ id: 'a', label: 'A', section: 0 }, { id: 'b', label: 'B', section: 1 }], links: [{ from: 'a', to: 'b', label: '' }, { from: 'b', to: 'a', label: '' }] });
  assert.equal(L.shapes.filter((s) => s.type === 'box').length, 2);
});
