// Pure cores for Smart Clipboard, Backup, Session snapshots and the Appearance transaction (vNext S1, S9, S17, S30).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';

import {createBackup, migrateBackup, restorePreview, stripSecrets, verifyBackup} from '../../shell/shared/backup.js';
import {cleanUrl, convertCase, formatJson, isExpired, prune, removeFormatting, sensitiveKind} from '../../shell/shared/clipboardTools.js';
import {diffSnapshots, migrateSnapshot, restorePlan, retain} from '../../shell/shared/snapshot.js';
import {beginTransaction} from '../../shell/shared/transaction.js';

const sha = s => createHash('sha256').update(s).digest('hex');

test('clipboard transforms return new text and handle bad input', () => {
    assert.equal(convertCase('hello big World', 'title'), 'Hello Big World');
    assert.equal(convertCase('helloBigWorld', 'snake'), 'hello_big_world');
    assert.equal(convertCase('Hello big world', 'camel'), 'helloBigWorld');
    assert.equal(convertCase('Hello big world', 'kebab'), 'hello-big-world');
    assert.throws(() => convertCase('x', 'weird'), /unknown case/);
    assert.equal(removeFormatting('<p>Hi&nbsp;<b>there</b> &amp; you</p><p>x</p>'), 'Hi there & you\nx');
    assert.equal(formatJson('{"a":[1,2]}').text, '{\n  "a": [\n    1,\n    2\n  ]\n}');
    assert.ok(formatJson('{a:').error);
    assert.equal(cleanUrl('https://x.org/p?id=3&utm_source=a&fbclid=z'), 'https://x.org/p?id=3');
    assert.equal(cleanUrl('just text'), 'just text');
    assert.equal(cleanUrl('javascript:alert(1)'), 'javascript:alert(1)');
});

test('sensitive content is recognised (fixtures are built at run time, none is a real secret)', () => {
    assert.equal(sensitiveKind('-----BEGIN ' + 'RSA PRIVATE KEY-----\nabc'), 'private-key');
    assert.equal(sensitiveKind('AKIA' + 'X'.repeat(16)), 'token');
    assert.equal(sensitiveKind('ghp_' + 'a1'.repeat(20)), 'token');
    assert.equal(sensitiveKind('eyJhbGciOi.eyJzdWIiOi.sig'), 'jwt');
    assert.equal(sensitiveKind('4242 4242 4242 4242'), 'card');
    assert.equal(sensitiveKind('4242 4242 4242 4241'), null);
    assert.equal(sensitiveKind('password: correct-horse'), 'password-line');
    assert.equal(sensitiveKind('a1'.repeat(20)), 'long-secret');
    assert.equal(sensitiveKind('meet at 5 pm, bring the 2 laptops'), null);
});

test('expiry and pruning: pinned stay, sensitive go unless asked', () => {
    const items = [{text: 'old', savedAt: 0}, {text: 'old pinned', savedAt: 0, pinned: true}, {text: 'fresh', savedAt: 900}, {text: 'password: x1', savedAt: 900}];
    assert.equal(isExpired(items[0], 1000, 500), true);
    assert.equal(isExpired(items[1], 1000, 500), false);
    assert.equal(isExpired(items[0], 1000, 0), false);
    assert.deepEqual(prune(items, 1000, {ttlMs: 500}).map(i => i.text), ['old pinned', 'fresh']);
    assert.equal(prune(items, 1000, {ttlMs: 500, keepSensitive: true}).length, 3);
});

test('backup leaves secrets out, verifies, detects tampering, previews a restore, migrates v1', () => {
    const b = createBackup([
        {path: 'ai/connections.json', content: JSON.stringify({provider: 'x', apiToken: 'abc', nested: {password: 'p', ok: 1}})},
        {path: 'secrets.json', content: '{}'}, {path: '../escape', content: 'x'}, {path: 'tile/rules.json', content: '[]'},
    ], sha, {now: () => 'T'});
    assert.deepEqual(b.files.map(f => f.path), ['ai/connections.json', 'tile/rules.json']);
    assert.deepEqual(b.skipped.map(s => s.reason), ['secret file', 'unsafe path']);
    assert.deepEqual(b.stripped, ['ai/connections.json:apiToken', 'ai/connections.json:nested.password']);
    assert.ok(!JSON.stringify(b).includes('abc'));
    assert.deepEqual(verifyBackup(b, sha), []);
    const bad = structuredClone(b); bad.files[1].content = '[1]';
    assert.match(verifyBackup(bad, sha)[0], /checksum/);
    assert.match(verifyBackup({version: 99, files: []}, sha)[0], /newer/);
    assert.deepEqual(restorePreview(b, {'tile/rules.json': '[]', 'ai/connections.json': 'old'}), {add: [], change: ['ai/connections.json'], same: ['tile/rules.json']});
    assert.equal(migrateBackup({version: 1, files: []}).version, 2);
    assert.throws(() => migrateBackup({version: 7, files: []}), /cannot migrate/);
    assert.equal(stripSecrets('not json').text, 'not json');
});

test('snapshots migrate, diff, plan an honest restore and retain', () => {
    const v1 = {version: 1, windows: [{app: 'firefox', workspace: 2}, {app: null}]};
    const s = migrateSnapshot(v1);
    assert.equal(s.version, 2);
    assert.equal(s.windows[0].appId, 'firefox');
    assert.throws(() => migrateSnapshot({version: 5, windows: []}), /cannot migrate/);
    const b = {version: 2, windows: [{appId: 'firefox', workspace: 3, monitor: 1}, {appId: 'code', workspace: 1, monitor: 0}]};
    const d = diffSnapshots({version: 2, windows: [{appId: 'Firefox', workspace: 2, monitor: 1}, {appId: 'gimp', workspace: 1, monitor: 0}]}, b);
    assert.equal(d.moved.length, 1); assert.equal(d.added[0].appId, 'code'); assert.equal(d.removed[0].appId, 'gimp');
    const plan = restorePlan({version: 2, windows: [...b.windows, {appId: null, workspace: 1, monitor: 0}]}, ['Firefox'], 1);
    assert.deepEqual(plan.map(p => p.action), ['place', 'relaunch', 'unsupported']);
    assert.match(plan[0].note, /not connected/);
    assert.equal(restorePlan(b, [], 2, ['code']).length, 1);
    const day = 864e5, snaps = [{at: 100 * day}, {at: 99 * day}, {at: 98 * day}, {at: 10 * day, pinned: true}, {at: 1 * day}];
    assert.deepEqual(retain(snaps, 100 * day, {max: 3, days: 30}).map(x => x.at / day), [100, 99, 10]);
});

test('an appearance transaction previews, cancels, commits and rolls back a failed write', () => {
    const live = {radius: 12, opacity: 0.8};
    const t = beginTransaction(live, ['radius']);
    assert.equal(t.set('radius', 20), true);
    assert.equal(t.set('opacity', 0.5), false);
    assert.throws(() => t.set('nope', 1), /unknown/);
    assert.deepEqual(t.unavailable(), ['opacity']);
    assert.equal(t.preview().radius, 20);
    assert.equal(live.radius, 12);
    assert.deepEqual(t.changes(), [{key: 'radius', before: 12, after: 20}]);
    const written = [];
    assert.deepEqual(t.commit((k, v) => written.push([k, v])), {ok: true, written: 1});
    t.cancel();
    assert.equal(t.after().radius, 12);
    const u = beginTransaction({a: 1, b: 2}, ['a', 'b']);
    u.set('a', 5); u.set('b', 6);
    const log = [];
    const r = u.commit((k, v) => { if (k === 'b' && v === 6) throw new Error('refused'); log.push([k, v]); });
    assert.deepEqual(r, {ok: false, error: 'b: refused', rolledBack: 1});
    assert.deepEqual(log, [['a', 5], ['a', 1]]);
});
