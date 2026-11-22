// PermissionService core (vNext S3).
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createPermissions} from '../../shell/shared/permissions.js';

test('default is ask; always allows; deny denies; revoke applies to the next call', () => {
    const p = createPermissions();
    assert.equal(p.decide('flow', 'launch'), 'ask');
    p.grant('flow', 'launch', 'always');
    assert.equal(p.decide('flow', 'launch'), 'allow');
    assert.equal(p.decide('flow', 'file'), 'ask');
    p.revoke('flow', 'launch');
    assert.equal(p.decide('flow', 'launch'), 'ask');
    p.grant('ai', 'ai-external', 'deny');
    assert.equal(p.decide('ai', 'ai-external'), 'deny');
});

test('allow once is spent; session ends with the session', () => {
    const p = createPermissions();
    p.grant('macro', 'window', 'once');
    assert.equal(p.decide('macro', 'window'), 'allow');
    assert.equal(p.decide('macro', 'window'), 'ask');
    p.grant('macro', 'window', 'session');
    assert.equal(p.decide('macro', 'window'), 'allow');
    assert.equal(p.decide('macro', 'window'), 'allow');
    p.endSession();
    assert.equal(p.decide('macro', 'window'), 'ask');
});

test('only always and deny are saved; junk on load is skipped', () => {
    const p = createPermissions();
    p.grant('a', 'file', 'always'); p.grant('b', 'file', 'deny'); p.grant('c', 'file', 'session'); p.grant('d', 'file', 'once');
    const text = p.serialize();
    const q = createPermissions();
    assert.equal(q.load(text), 2);
    assert.deepEqual(q.list().map(g => g.subject).sort(), ['a', 'b']);
    assert.equal(q.load('nope'), 0);
    assert.equal(q.load('{"grants":[{"subject":"x y","capability":"file","scope":"always"},{"subject":"x","capability":"root","scope":"always"},{"subject":"x","capability":"file","scope":"once"}]}'), 0);
});

test('bad input throws; history is bounded, has no content, and can be cleared', () => {
    const p = createPermissions({now: () => 5});
    assert.throws(() => p.decide('a b', 'file'), /subject/);
    assert.throws(() => p.decide('a', 'root'), /capability/);
    assert.throws(() => p.grant('a', 'file', 'forever'), /scope/);
    for (let i = 0; i < 250; i++)
        p.decide('a', 'file');
    assert.equal(p.history().length, 200);
    assert.deepEqual(Object.keys(p.history()[0]), ['at', 'subject', 'capability', 'verdict']);
    p.clearHistory();
    assert.equal(p.history().length, 0);
});
