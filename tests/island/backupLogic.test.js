// Backup & Restore logic (no screen): export (secrets left out), parse (size, format, version, checksum), plan (per-key diff, unknown key,
// wrong type, locked, secret), apply through the transaction (read-back, rollback), undo, and the controller's states. All with a fake
// settings backend and a fake file store: nothing real is read or written.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';

import {
    applyPlan, createBackupFlow, EXCLUSIONS, exportSettings, FORMAT, inversePlan, isSecretKey, looksSecretValue, MAX_BYTES, parseBackup, planImport, SOURCES,
} from '../../control/build/backupLogic.js';

const hash = t => createHash('sha256').update(t).digest('hex');
const TYPES = {
    niro: {opacity: 'i', accent: 's', 'ai-api-key': 's', 'gate-token': 's', 'hub-on': 'b', 'tags': 'as', locked: 'b'},
    dock: {'icon-size': 'i', 'icon-style': 's', hint: 's'},
};
const BOOL = /^(true|false)$/, INT = /^-?\d+$/, STR = /^'[^']*'$/, STRV = /^\[('[^']*'(, '[^']*')*)?\]$/;
const CHECK = {b: BOOL, i: INT, s: STR, as: STRV};

function fake(initial, {failWrite = null, ignoreWrite = null, sources = ['niro', 'dock']} = {}) {
    const store = JSON.parse(JSON.stringify(initial));
    const f = {
        store, writes: [],
        settings: {
            sources: () => sources,
            keys: s => ({...TYPES[s]}),
            read(s, k) { if (!(k in store[s])) throw new Error('no key'); return store[s][k]; },
            canon(s, k, text) {
                if (!CHECK[TYPES[s][k]].test(text)) throw new Error('not a value');
                if (k === 'opacity' && Number(text) > 100) throw new Error('outside the allowed range');
                return text;
            },
            writable: (_s, k) => k !== 'locked',
            write(s, k, text) {
                f.writes.push([`${s}.${k}`, text]);
                if (`${s}.${k}` === failWrite) throw new Error('write refused');
                if (`${s}.${k}` !== ignoreWrite) store[s][k] = text;
            },
        },
        hash,
    };
    return f;
}
const initial = () => ({
    niro: {opacity: '80', accent: "'#E8472B'", 'ai-api-key': "'sk-AAAAAAAAAAAAAAAAAAAA'", 'gate-token': "'x'", 'hub-on': 'false', tags: "['a', 'b']", locked: 'false'},
    dock: {'icon-size': '40', 'icon-style': "'flat'", hint: "'Bearer abcdefghijklmnopqrstuvwxyz'"},
});

test('export leaves secrets out by key name and by value shape, and says so', () => {
    const f = fake(initial());
    const r = exportSettings({...f, appVersion: '9.9.9', now: () => '2026-01-01T00:00:00Z'});
    assert.ok(r.ok);
    const doc = JSON.parse(r.text);
    assert.ok(!r.text.includes('sk-AAAA') && !r.text.includes('Bearer'));
    const inner = Object.assign({}, ...doc.files.map(x => JSON.parse(x.content)));
    assert.ok(!('gate-token' in inner) && !('ai-api-key' in inner) && !('hint' in inner) && 'icon-size' in inner, 'no entry for a secret');
    assert.deepEqual(r.excluded.sort(), ['dock.hint', 'niro.ai-api-key', 'niro.gate-token']);
    assert.equal(doc.format, FORMAT);
    assert.equal(doc.appVersion, '9.9.9');
    assert.equal(r.keys, 7);
    assert.ok(EXCLUSIONS.some(e => /token/.test(e)) && EXCLUSIONS.some(e => /API keys/.test(e)));
    assert.ok(isSecretKey('openai-API_KEY') && isSecretKey('Passphrase-file') && !isSecretKey('icon-size'));
    assert.ok(looksSecretValue("'ghp_abcdefghijklmnop'") && !looksSecretValue("'#E8472B'"));
});

test('export only covers installed sources, and refuses when there is nothing', () => {
    const f = fake(initial(), {sources: ['dock']});
    const doc = JSON.parse(exportSettings(f).text);
    assert.deepEqual(doc.files.map(x => x.path), ['settings/dock.json']);
    const none = exportSettings(fake(initial(), {sources: []}));
    assert.equal(none.ok, false);
    assert.match(none.error, /no Niro settings/);
});

test('export then import into a changed system: a per-key diff, then apply, then undo', () => {
    const a = fake(initial());
    const text = exportSettings(a).text;
    const b = fake({...initial(), niro: {...initial().niro, opacity: '50', accent: "'#000000'"}, dock: {...initial().dock, 'icon-size': '64'}});
    const parsed = parseBackup(text, b);
    assert.ok(parsed.ok, parsed.error);
    const plan = planImport(parsed.entries, b);
    assert.ok(plan.ok);
    assert.deepEqual(plan.changes.map(c => [c.id, c.before, c.after]), [['niro.accent', "'#000000'", "'#E8472B'"], ['niro.opacity', '50', '80'], ['dock.icon-size', '64', '40']].sort((x, y) => 0) && plan.changes.map(c => [c.id, c.before, c.after]));
    assert.equal(plan.changes.length, 3);
    assert.equal(b.writes.length, 0, 'planning writes nothing');
    const r = applyPlan(plan, b);
    assert.ok(r.ok);
    assert.equal(r.written, 3);
    assert.equal(b.store.niro.opacity, '80');
    assert.equal(b.store.niro['ai-api-key'], "'sk-AAAAAAAAAAAAAAAAAAAA'", 'a secret setting on this machine is untouched');
    const u = applyPlan(inversePlan(plan), b);
    assert.ok(u.ok);
    assert.equal(b.store.niro.opacity, '50');
    assert.equal(b.store.dock['icon-size'], '64');
});

test('a second import of the same backup changes nothing', () => {
    const a = fake(initial());
    const parsed = parseBackup(exportSettings(a).text, a);
    const plan = planImport(parsed.entries, a);
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.unchanged, 7);
    assert.deepEqual(applyPlan(plan, a), {ok: true, written: 0});
});

function tampered(edit) {
    const a = fake(initial());
    const doc = JSON.parse(exportSettings(a).text);
    edit(doc);
    return JSON.stringify(doc);
}
const rehash = f => { f.hash = hash(f.content); };

test('parse refuses: empty, too big, not JSON, wrong format, newer versions, damaged checksum, unknown file', () => {
    const h = {hash};
    assert.match(parseBackup('', h).error, /empty/);
    assert.match(parseBackup('x'.repeat(MAX_BYTES + 1), h).error, /larger than 1 MB/);
    assert.match(parseBackup('{nope', h).error, /not valid JSON/);
    assert.match(parseBackup('{"a":1}', h).error, /not a Niro settings backup/);
    assert.match(parseBackup(tampered(d => { d.settingsFormat = 2; }), h).error, /newer than this program/);
    assert.match(parseBackup(tampered(d => { d.version = 99; }), h).error, /newer/);
    assert.match(parseBackup(tampered(d => { d.files[0].content = d.files[0].content.replace('80', '81'); }), h).error, /damaged/);
    assert.match(parseBackup(tampered(d => { d.files[0].path = 'settings/evil.json'; rehash(d.files[0]); }), h).error, /does not know/);
    assert.match(parseBackup(tampered(d => { d.files[0].path = '../x.json'; rehash(d.files[0]); }), h).error, /damaged|does not know/);
    assert.match(parseBackup(tampered(d => { d.files[0].content = '[1]'; rehash(d.files[0]); }), h).error, /not a list/);
    assert.match(parseBackup(tampered(d => { d.files[0].content = '{"a":{"type":"b","value":1}}'; rehash(d.files[0]); }), h).error, /not a setting entry/);
});

test('plan refuses unknown keys, wrong types, bad values, secrets and locked keys, and lists every problem', () => {
    const b = fake(initial());
    const entry = (type, value) => ({type, value});
    const plan = planImport({
        niro: {nope: entry('b', 'true'), accent: entry('i', '3'), opacity: entry('i', '500'), 'ai-api-key': entry('s', "'x'"), 'hub-on': entry('b', 'maybe'), locked: entry('b', 'true'), tags: entry('as', "['z']")},
        dock: {hint: entry('s', "'ok'")},
        corners: {anything: entry('b', 'true')},
    }, b);
    assert.equal(plan.ok, false);
    const text = plan.problems.join('\n');
    assert.match(text, /niro\.nope: no such setting/);
    assert.match(text, /niro\.accent: wrong type/);
    assert.match(text, /niro\.opacity: not a valid value/);
    assert.match(text, /niro\.ai-api-key: looks like a secret/);
    assert.match(text, /niro\.hub-on: not a valid value/);
    assert.match(text, /niro\.locked: is locked/);
    assert.deepEqual(plan.skipped, ['corners']);
    assert.deepEqual(plan.changes.map(c => c.id), ['niro.tags', 'dock.hint'].filter(id => plan.changes.some(c => c.id === id)));
    const r = applyPlan(plan, b);
    assert.equal(r.ok, false);
    assert.equal(b.writes.length, 0, 'a refused plan writes nothing');
});

test('a write that fails puts the earlier writes back (rollback)', () => {
    const a = fake(initial());
    const text = exportSettings(a).text;
    const start = {...initial(), niro: {...initial().niro, opacity: '50', accent: "'#000000'"}, dock: {...initial().dock, 'icon-size': '64'}};
    const b = fake(start, {failWrite: 'dock.icon-size'});
    const plan = planImport(parseBackup(text, b).entries, b);
    const r = applyPlan(plan, b);
    assert.equal(r.ok, false);
    assert.match(r.error, /icon-size: write refused/);
    assert.deepEqual(b.store, start, 'every setting is as it was');
});

test('a key that does not keep its value is caught by the read-back and everything is put back', () => {
    const a = fake(initial());
    const text = exportSettings(a).text;
    const start = {...initial(), niro: {...initial().niro, opacity: '50', accent: "'#000000'"}};
    const b = fake(start, {ignoreWrite: 'niro.opacity'});
    const plan = planImport(parseBackup(text, b).entries, b);
    const r = applyPlan(plan, b);
    assert.equal(r.ok, false);
    assert.match(r.error, /niro\.opacity did not keep/);
    assert.deepEqual(b.store, start);
});

const files = (content = null) => {
    const f = {store: {}, reads: [], fail: null};
    f.read = p => { f.reads.push(p); if (f.fail) throw new Error(f.fail); if (!(p in f.store)) throw new Error('No such file'); return f.store[p]; };
    f.write = (p, t) => { if (f.fail) throw new Error(f.fail); f.store[p] = t; };
    if (content) f.store['/b.json'] = content;
    return f;
};
const settle = () => new Promise(r => setImmediate(r));

test('controller: loading -> ready, empty, error', async () => {
    const f = fake(initial());
    const c = createBackupFlow({...f}, files());
    assert.equal(c.state.view, 'loading');
    await c.refresh();
    assert.equal(c.state.view, 'ready');
    assert.deepEqual(c.state.groups.map(g => g[0]), ['niro', 'dock']);
    const e = createBackupFlow(fake(initial(), {sources: []}), files()); await e.refresh();
    assert.equal(e.state.view, 'empty');
    const g = fake(initial()); g.settings.sources = () => { throw new Error('schema source broke'); };
    const x = createBackupFlow(g, files()); await x.refresh();
    assert.equal(x.state.view, 'error'); assert.match(x.state.message, /schema source broke/);
});

test('controller: export states (exporting, success, error) and nothing is written without being asked', async () => {
    const f = fake(initial()), fs = files();
    const c = createBackupFlow(f, fs); await c.refresh();
    assert.deepEqual(fs.store, {});
    const seen = []; c.subscribe(() => seen.push(c.state.busy));
    await c.exportTo('/tmp/x/out.json');
    assert.ok(seen.includes('exporting'));
    assert.equal(c.state.busy, null);
    assert.equal(c.state.status.kind, 'success');
    assert.match(c.state.status.text, /out\.json/);
    assert.match(c.state.status.text, /3 secret-looking/);
    assert.ok(fs.store['/tmp/x/out.json']);
    fs.fail = 'disk full';
    await c.exportTo('/tmp/x/out2.json');
    assert.equal(c.state.status.kind, 'error'); assert.match(c.state.status.text, /disk full/);
});

test('controller: preview -> cancel, preview -> apply (applying, success), refused file, rollback, undo', async () => {
    const a = fake(initial());
    const text = exportSettings(a).text;
    const start = {...initial(), niro: {...initial().niro, opacity: '50'}};
    const b = fake(start), fs = files(text);
    const c = createBackupFlow(b, fs); await c.refresh();
    await c.loadFile('/b.json');
    assert.equal(c.state.plan.ok, true);
    assert.equal(c.state.plan.changes.length, 1);
    assert.equal(c.state.plan.file, 'b.json');
    c.cancel(); assert.equal(c.state.plan, null);
    assert.equal(b.writes.length, 0);

    await c.loadFile('/b.json');
    const phases = []; c.subscribe(() => phases.push(c.state.busy));
    await c.apply();
    assert.ok(phases.includes('applying'));
    assert.equal(c.state.status.kind, 'success');
    assert.equal(b.store.niro.opacity, '80');
    await c.undo();
    assert.equal(b.store.niro.opacity, '50');
    assert.match(c.state.status.text, /undone/);

    // refused file
    fs.store['/bad.json'] = '{"format":"other"}';
    await c.loadFile('/bad.json');
    assert.equal(c.state.plan, null); assert.equal(c.state.status.kind, 'error');
    await c.loadFile('/missing.json');
    assert.match(c.state.status.text, /No such file/);

    // rollback
    const r = fake(start, {failWrite: 'niro.opacity'}); const c2 = createBackupFlow(r, files(text)); await c2.refresh();
    await c2.loadFile('/b.json'); await c2.apply();
    assert.equal(c2.state.status.kind, 'rollback');
    assert.match(c2.state.status.text, /put back/);
    assert.deepEqual(r.store, start);

    // a refused plan cannot be applied
    const bad = JSON.parse(text); bad.files[0].content = JSON.stringify({nope: {type: 'b', value: 'true'}}); rehash(bad.files[0]);
    const c3 = createBackupFlow(fake(start), files(JSON.stringify(bad))); await c3.refresh(); await c3.loadFile('/b.json');
    assert.equal(c3.state.plan.ok, false);
    await c3.apply();
    assert.equal(c3.state.status, null);
});

test('controller ignores a second action while one is running', async () => {
    const f = fake(initial()), fs = files();
    const c = createBackupFlow(f, fs); await c.refresh();
    const p = c.exportTo('/a.json'); const q = c.exportTo('/b2.json');
    await Promise.all([p, q]); await settle();
    assert.deepEqual(Object.keys(fs.store), ['/a.json']);
});

test('SOURCES are the ones the settings store knows', () => {
    assert.deepEqual(SOURCES.map(s => s[0]), ['niro', 'island', 'dock', 'tile', 'blur', 'corners', 'emoji']);
});
