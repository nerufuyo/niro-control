// Permissions and Connectivity logic with fake backends: parsing (invalid entries dropped, history without arguments), the grant rules
// (allowing needs confirmation, deny and revoke do not), error kinds, and the connectivity controller. Nothing real is touched.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {createConnectivityFlow, ITEMS, parseAvailability, parseOutcome as connOutcome} from '../../control/build/connectivityLogic.js';
import {
    CAPABILITIES, classifyError, createPermissionsFlow, givesMoreAccess, needsConfirmation, parseGrants, parseHistory, parseOutcome, SCOPES, validateGrant, whenText,
} from '../../control/build/permissionsLogic.js';

test('the lists match the shared core', () => {
    const src = readFileSync(new URL('../../shell/shared/permissions.js', import.meta.url), 'utf8');
    const list = name => JSON.parse(new RegExp(`export const ${name} = (\\[[^\\]]*\\])`).exec(src)[1].replace(/'/g, '"'));
    assert.deepEqual(CAPABILITIES, list('CAPABILITIES'));
    assert.deepEqual(SCOPES, list('SCOPES'));
});

test('parseGrants drops invalid entries and sorts', () => {
    const r = parseGrants(JSON.stringify({enforced: true, grants: [
        {subject: 'b', capability: 'file', scope: 'always'}, {subject: 'a', capability: 'file', scope: 'deny'},
        {subject: 'bad name', capability: 'file', scope: 'always'}, {subject: 'c', capability: 'nope', scope: 'always'}, {subject: 'c', capability: 'file', scope: 'forever'}, null]}));
    assert.equal(r.enforced, true);
    assert.deepEqual(r.grants.map(g => g.subject), ['a', 'b']);
    assert.equal(parseGrants('{"grants": 5}').grants.length, 0);
    assert.throws(() => parseGrants('not json'), /unreadable/);
});

test('parseHistory keeps four fields only, newest first', () => {
    const h = parseHistory(JSON.stringify([{at: 1, subject: 'x', capability: 'file', verdict: 'allow', args: {text: 'SECRET'}, content: 'SECRET'}, {at: 5, subject: 'y', capability: 'file', verdict: 'deny'}, {at: 9, subject: 'z', capability: 'file', verdict: 'maybe'}]));
    assert.deepEqual(h.map(e => e.subject), ['y', 'x']);
    assert.deepEqual(Object.keys(h[0]).sort(), ['at', 'capability', 'subject', 'verdict']);
    assert.ok(!JSON.stringify(h).includes('SECRET'));
});

test('access rules', () => {
    assert.ok(needsConfirmation('once') && needsConfirmation('session') && needsConfirmation('always'));
    assert.ok(!needsConfirmation('deny'));
    assert.ok(givesMoreAccess(null, 'once') && givesMoreAccess('once', 'always') && givesMoreAccess('deny', 'once'));
    assert.ok(!givesMoreAccess('always', 'once') && !givesMoreAccess('always', 'deny') && !givesMoreAccess(null, 'deny'));
    assert.match(validateGrant('a b', 'file', 'deny'), /program name/);
    assert.match(validateGrant('a', 'root', 'deny'), /Unknown capability/);
    assert.match(validateGrant('a', 'file', 'x'), /Unknown scope/);
    assert.equal(validateGrant('a.b-c:1', 'file', 'once'), null);
});

test('error kinds', () => {
    assert.equal(classifyError(new Error('org.freedesktop.DBus.Error.ServiceUnknown x')).kind, 'unavailable');
    assert.equal(classifyError(new Error('org.freedesktop.DBus.Error.UnknownMethod x')).kind, 'unsupported');
    assert.equal(classifyError(new Error('AccessDenied')).kind, 'permission');
    assert.equal(classifyError(new Error('GDBus.Error:org.x.Y: boom')).message, 'boom');
});

function fake({grants = [], failList = null, grantAnswer = {ok: true}} = {}) {
    const calls = [], store = {grants: [...grants], hist: [{at: 1, subject: 's', capability: 'file', verdict: 'ask'}]};
    return {
        calls, store,
        list: async () => { if (failList) throw failList; return {enforced: false, grants: [...store.grants]}; },
        grant: async (s, c, sc) => { calls.push(['grant', s, c, sc]); if (grantAnswer.ok) store.grants = store.grants.filter(g => !(g.subject === s && g.capability === c)).concat({subject: s, capability: c, scope: sc}); return {declined: false, error: '', ...grantAnswer}; },
        revoke: async (s, c) => { calls.push(['revoke', s, c]); store.grants = store.grants.filter(g => !(g.subject === s && g.capability === c)); return {ok: true, declined: false, error: ''}; },
        history: async () => store.hist,
        clearHistory: async () => { calls.push(['clear']); store.hist = []; return {ok: true, declined: false, error: ''}; },
    };
}

test('flow: allowing without confirmation is refused and never reaches the backend; deny and revoke go straight', async () => {
    const b = fake(), f = createPermissionsFlow(b);
    await f.refresh();
    assert.equal(f.state.view, 'ready');
    assert.equal(await f.grant('app', 'file', 'always'), false);
    assert.deepEqual(b.calls, []);
    assert.match(f.state.status.text, /confirmation/);
    assert.equal(await f.grant('app', 'file', 'deny'), true);
    assert.deepEqual(b.calls, [['grant', 'app', 'file', 'deny']]);
    assert.deepEqual(f.state.grants, [{subject: 'app', capability: 'file', scope: 'deny'}]);
    assert.equal(await f.grant('app', 'file', 'once', true), true);
    assert.equal(await f.revoke('app', 'file'), true);
    assert.equal(f.state.grants.length, 0);
    assert.equal(await f.grant('bad name', 'file', 'deny'), false);
    assert.equal(await f.revoke('bad name', 'file'), false);
    await f.clearHistory();
    assert.equal(f.state.history.length, 0);
});

test('flow: declined on the screen changes nothing; refusals and an absent Search are reported', async () => {
    const d = createPermissionsFlow(fake({grantAnswer: {ok: false, declined: true}}));
    await d.refresh();
    assert.equal(await d.grant('app', 'file', 'always', true), false);
    assert.equal(d.state.status.kind, 'info');
    const e = createPermissionsFlow(fake({grantAnswer: {ok: false, error: 'nope'}}));
    await e.refresh(); await e.grant('app', 'file', 'always', true);
    assert.equal(e.state.status.text, 'nope');
    const u = createPermissionsFlow(fake({failList: classifyError(new Error('ServiceUnknown'))}));
    await u.refresh();
    assert.equal(u.state.view, 'unavailable');
    const x = createPermissionsFlow(fake({failList: new Error('weird')}));
    await x.refresh();
    assert.equal(x.state.view, 'error');
});

test('outcome and time text', () => {
    assert.deepEqual(parseOutcome('{"ok":false,"code":"declined","error":"cancelled"}'), {ok: false, declined: true, error: 'cancelled'});
    assert.equal(whenText(0), 'unknown time');
    assert.equal(whenText(1000, 1000 + 5 * 60000), '5 min ago');
});

test('connectivity: parsing, confirm gate, no state is invented', async () => {
    assert.deepEqual(parseAvailability('{"available":false,"reason":"Bluetooth tools are not installed"}'), {available: false, reason: 'Bluetooth tools are not installed'});
    assert.equal(parseAvailability('junk').available, false);
    assert.equal(connOutcome('{"ok":true,"message":"Wi-Fi off"}').message, 'Wi-Fi off');
    const ran = [];
    const backend = {
        availability: async id => id === 'system.bluetooth.toggle' ? {available: false, reason: 'no tools'} : {available: true, reason: null},
        run: async id => { ran.push(id); return {ok: true, message: 'Wi-Fi off', code: '', error: ''}; },
    };
    let answer = false;
    const f = createConnectivityFlow(backend, async () => answer);
    await f.refresh();
    assert.equal(f.state.view, 'ready');
    assert.deepEqual(f.state.rows.map(r => r.available), [true, false, true]);
    assert.ok(f.state.rows.every(r => r.last === null), 'no state before a toggle');
    assert.equal(await f.toggle('wifi'), false); assert.deepEqual(ran, []);
    answer = true;
    assert.equal(await f.toggle('bluetooth'), false); assert.deepEqual(ran, [], 'unavailable never runs');
    assert.equal(await f.toggle('wifi'), true); assert.deepEqual(ran, ['system.wifi.toggle']);
    assert.equal(f.state.rows[0].last, 'Wi-Fi off');
    assert.deepEqual(ITEMS.map(i => i.actionId), ['system.wifi.toggle', 'system.bluetooth.toggle', 'system.vpn.toggle']);
});

test('connectivity: Search absent', async () => {
    const f = createConnectivityFlow({availability: async () => { throw new Error('ServiceUnknown'); }, run: async () => { throw new Error('x'); }}, async () => true);
    await f.refresh();
    assert.equal(f.state.view, 'unavailable');
    assert.match(f.state.message, /not running/);
    assert.equal(await f.toggle('wifi'), false);
});
