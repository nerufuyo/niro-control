// Shelf 2.0 core (vNext 19): collections of references; originals are never touched.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createShelf} from '../../shell/shared/shelfCollections.js';

const file = (n, extra = {}) => ({kind: 'file', uri: `file:///home/u/${n}`, ...extra});

test('create, rename, pin; names are unique ignoring case', () => {
    const s = createShelf();
    const a = s.create('Work').id;
    assert.equal(s.create('work').reason, 'name taken');
    assert.equal(s.create('  ').reason, 'empty name');
    assert.equal(s.rename(a, 'Projects').ok, true);
    assert.equal(s.rename('zz', 'x').ok, false);
    assert.equal(s.pin(a).ok, true);
    assert.equal(s.collections[0].pinned, true);
});

test('references are validated by kind', () => {
    const s = createShelf();
    const c = s.create('C').id;
    assert.equal(s.add(c, file('a.txt')).ok, true);
    assert.equal(s.add(c, file('a.txt')).reason, 'duplicate');
    assert.equal(s.add(c, {kind: 'file', uri: 'https://x.org/a'}).ok, false);
    assert.equal(s.add(c, {kind: 'url', uri: 'file:///etc/passwd'}).ok, false);
    assert.equal(s.add(c, {kind: 'url', uri: 'https://example.org/p'}).ok, true);
    assert.equal(s.add(c, {kind: 'image', uri: 'file:///home/u/p.png'}).ok, true);
    assert.equal(s.add(c, {kind: 'text', text: ' '}).ok, false);
    assert.equal(s.add(c, {kind: 'weird'}).ok, false);
    assert.equal(s.add(c, {kind: 'file', uri: 'nonsense'}).reason, 'invalid uri');
});

test('snippet quota is enforced and counts copies', () => {
    const s = createShelf({quotaBytes: 20, snippetMax: 15});
    const a = s.create('A').id, b = s.create('B').id;
    assert.equal(s.add(a, {kind: 'text', text: '0123456789'}).ok, true);
    assert.equal(s.add(a, {kind: 'text', text: '0123456789ABCDEF'}).reason, 'snippet too large');
    assert.equal(s.add(b, {kind: 'text', text: 'abcdefghijk'}).reason, 'quota');
    const id = s.collections[0].items[0].id;
    const plan = s.plan([{op: 'copy', from: a, to: b, items: [id]}]);
    assert.equal(plan.steps.length, 1);                      // 10 + 10 = 20 fits exactly
    s.apply(plan);
    assert.equal(s.quota.used, 20);
    assert.equal(s.plan([{op: 'copy', from: a, to: b, items: [id]}]).rejected[0].reason, 'quota');
});

test('batch plan: move/copy/remove only; delete-file is rejected; originals untouched', () => {
    const s = createShelf();
    const a = s.create('A').id, b = s.create('B').id;
    const i1 = s.add(a, file('1')).id, i2 = s.add(a, file('2')).id;
    const plan = s.plan([
        {op: 'move', from: a, to: b, items: [i1]},
        {op: 'copy', from: a, to: b, items: [i2]},
        {op: 'delete-file', from: a, items: [i2]},
        {op: 'remove', from: a, items: ['missing']},
    ]);
    assert.equal(plan.touchesOriginals, false);
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.rejected.length, 2);
    assert.match(plan.rejected[0].reason, /only move, copy and remove/);
    assert.equal(s.collections[0].items.length, 2);          // plan alone changes nothing
    const r = s.apply(plan);
    assert.equal(r.touchesOriginals, false);
    assert.equal(s.collections[0].items.length, 1);          // i1 moved out, i2 stays (copied)
    assert.equal(s.collections[1].items.length, 2);
    assert.notEqual(s.collections[1].items[1].id, i2);       // the copy has its own id
});

test('removing an item or collection only drops references', () => {
    const s = createShelf();
    const a = s.create('A').id;
    const i = s.add(a, file('x')).id;
    assert.deepEqual(s.remove(a, i), {ok: true, touchesOriginals: false});
    assert.equal(s.removeCollection(a).touchesOriginals, false);
    assert.equal(s.collections.length, 0);
});

test('search finds names, URIs and snippet text', () => {
    const s = createShelf();
    const a = s.create('Invoices').id;
    s.add(a, file('report-2026.pdf'));
    s.add(a, {kind: 'text', text: 'Remember the PASSPORT number'});
    assert.equal(s.search('invoice').length, 1);
    assert.equal(s.search('report').length, 1);
    assert.equal(s.search('passport').length, 1);
    assert.deepEqual(s.search(''), []);
});

test('temporary collections expire; pinned ones never do; cleanup caps unpinned', () => {
    const s = createShelf({maxUnpinned: 2});
    const t = s.create('Temp', {ttlMs: 1000, now: 0}).id;
    const p = s.create('Keep', {ttlMs: 1000, now: 0}).id;
    s.pin(p);
    assert.deepEqual(s.previewCleanup(999), []);
    assert.deepEqual(s.previewCleanup(1000).map(x => x.id), [t]);
    assert.equal(s.collections.length, 2);                   // preview removes nothing
    s.cleanup(5000);
    assert.deepEqual(s.collections.map(c => c.id), [p]);
    for (let i = 0; i < 4; i++)
        s.create(`n${i}`, {now: i});
    const over = s.cleanup(10).removed;
    assert.deepEqual(over.map(x => x.reason), ['over-limit', 'over-limit']);
    assert.equal(s.collections.length, 3);
});

test('legacy flat shelf imports as file references', () => {
    const s = createShelf();
    const r = s.fromLegacy([{uri: 'file:///a/b.txt', name: 'b.txt'}, {uri: 'https://x/y', name: 'y'}]);
    assert.equal(r.added, 1);
    assert.equal(s.collections[0].items[0].name, 'b.txt');
});

test('load restores a snapshot, re-checks every reference, and keeps ids unique afterwards', () => {
    const a = createShelf();
    const c = a.create('Trip').id;
    a.add(c, {kind: 'text', text: 'hello'});
    a.add(c, {kind: 'url', uri: 'https://example.org/'});
    const b = createShelf();
    assert.deepEqual(b.load(a.snapshot()), {collections: 1});
    assert.deepEqual(b.snapshot(), a.snapshot());
    assert.equal(b.create('Next').id, 'c4');                      // the counter continues past what was loaded
    const bad = createShelf();
    bad.load([{id: 'c1', name: 'ok', items: [{id: 'i1', kind: 'file', uri: 'https://x.org'}, {id: 'i2', kind: 'url', uri: 'javascript:1'}, {id: 'x', kind: 'text', text: 'no id'}]},
        {id: 'c1', name: 'dup id', items: []}, {id: 'c2', name: 'OK', items: []}, {id: 'bad', name: 'x'}, null]);
    assert.equal(bad.collections.length, 1);
    assert.equal(bad.collections[0].items.length, 0);
    assert.deepEqual(createShelf().load('nonsense'), {collections: 0});
});
