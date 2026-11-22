// Monitor manager core (vNext 12): identity, profiles, hotplug diff, fallback and restore plans. Planning only.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import * as m from '../../shell/shared/monitorManager.js';

const raw = (o = {}) => ({connector: 'DP-1', vendor: 'DEL', product: 'U2720Q', serial: 'ABC123SECRET', width: 3840, height: 2160, scale: 2, x: 0, y: 0, primary: true, ...o});
const A = m.monitorIdentity(raw());
const B = m.monitorIdentity(raw({connector: 'HDMI-1', vendor: 'AOC', product: '27G', serial: 'ZZ9', width: 1920, height: 1080, scale: 1, x: 1920, primary: false}));

test('identity: stable key, hashed serial, no raw serial anywhere, logical size = physical / scale', () => {
    assert.equal(A.key, m.monitorIdentity(raw()).key);
    assert.ok(!JSON.stringify(A).includes('ABC123SECRET'));
    assert.match(A.serialHash, /^[0-9a-f]{8}$/);
    assert.deepEqual(A.logical, {width: 1920, height: 1080});
    assert.equal(m.monitorIdentity(raw({scale: 1.5, width: 2880, height: 1800})).logical.width, 1920);
    assert.equal(m.monitorIdentity(raw({serial: ''})).serialHash, 'none');
    assert.equal(m.monitorIdentity(raw({scale: 0})).scale, 1);
    assert.equal(m.monitorIdentity({}).logical.width, 0);
});

test('same hardware on another port is recognised only with a real serial', () => {
    const moved = m.monitorIdentity(raw({connector: 'DP-2'}));
    assert.notEqual(moved.key, A.key);
    assert.equal(m.sameHardware(A, moved), true);
    const n1 = m.monitorIdentity(raw({serial: ''})), n2 = m.monitorIdentity(raw({serial: '', connector: 'DP-2'}));
    assert.equal(m.sameHardware(n1, n2), false);
});

test('set key ignores enumeration order; primary falls back to origin then first', () => {
    assert.equal(m.setKey([A, B]), m.setKey([B, A]));
    assert.equal(m.primaryOf([B, A]).key, A.key);
    assert.equal(m.primaryOf([{...B, primary: false}, {...A, primary: false}]).key, A.key, 'origin');
    assert.equal(m.primaryOf([]), null);
});

test('hotplug diff: connected, disconnected, moved port, unchanged', () => {
    assert.equal(m.diffMonitors([A, B], [B, A]).changed, false);
    const d = m.diffMonitors([A], [A, B]);
    assert.deepEqual(d.connected.map(x => x.key), [B.key]); assert.equal(d.disconnected.length, 0);
    const d2 = m.diffMonitors([A, B], [A]);
    assert.deepEqual(d2.disconnected.map(x => x.key), [B.key]);
    const moved = m.monitorIdentity(raw({connector: 'DP-2'}));
    const d3 = m.diffMonitors([A], [moved]);
    assert.deepEqual(d3.moved, [{from: A.key, to: moved.key}]); assert.equal(d3.connected.length, 0);
});

const wins = [
    {id: 1, monitor: A.key, x: 100, y: 100, width: 800, height: 600},
    {id: 2, monitor: B.key, x: 1500, y: 900, width: 1920, height: 1000},
    {id: 3, monitor: B.key, x: 10, y: 10, width: 300, height: 200},
];

test('fallback moves windows of a vanished monitor to the primary, clamped on screen; others stay', () => {
    const p = m.fallbackPlan(wins, [A], [B]);
    assert.equal(p.target, A.key);
    assert.deepEqual(p.moves.map(x => x.windowId), [2, 3]);
    for (const mv of p.moves) {
        assert.ok(mv.rect.x >= 0 && mv.rect.y >= 0);
        assert.ok(mv.rect.x + mv.rect.width <= A.logical.width && mv.rect.y + mv.rect.height <= A.logical.height, 'fully visible');
    }
    assert.equal(p.moves[1].rect.x, 10);
});

test('fallback with no monitor left plans nothing and explains', () => {
    const p = m.fallbackPlan(wins, [], [A, B]);
    assert.deepEqual(p.moves, []); assert.match(p.notes[0], /no monitor/);
});

test('restore plan returns displaced windows when the monitor comes back; closed ones are reported', () => {
    const fb = m.fallbackPlan(wins, [A], [B]);
    const mem = m.rememberDisplaced(fb, wins);
    assert.equal(mem[B.key].length, 2);
    const nowLive = [{id: 2, monitor: A.key}, {id: 3, monitor: B.key}];
    const r = m.restorePlan(mem, B, nowLive);
    assert.deepEqual(r.moves.map(x => x.windowId), [2], 'window 3 is already there');
    assert.ok(r.moves[0].rect.x + r.moves[0].rect.width <= B.logical.width);
    const r2 = m.restorePlan(mem, B, [{id: 3, monitor: B.key}]);
    assert.deepEqual(r2.missing, [2]);
    assert.deepEqual(m.restorePlan({}, B, nowLive), {moves: [], missing: []});
});

test('profiles are keyed by the monitor set, replaced per set and capped', () => {
    let ps = m.saveProfile([], 'Desk', [A, B], {note: 'x'});
    assert.equal(m.findProfile(ps, [B, A]).name, 'Desk');
    assert.equal(m.findProfile(ps, [A]), null, 'a different set is a different situation');
    ps = m.saveProfile(ps, 'Desk v2', [B, A]);
    assert.equal(ps.length, 1); assert.equal(ps[0].name, 'Desk v2');
    assert.equal(ps[0].primary, A.key);
    assert.throws(() => m.saveProfile([], '', [A]));
    assert.throws(() => m.saveProfile([], 'x', []));
    let many = [];
    for (let i = 0; i < 30; i++) many = m.saveProfile(many, `p${i}`, [m.monitorIdentity(raw({serial: `s${i}`}))]);
    assert.equal(many.length, m.MAX_PROFILES);
    assert.ok(!JSON.stringify(ps).includes('SECRET'));
});

test('profile drift reports scale and position changes without writing anything', () => {
    const ps = m.saveProfile([], 'Desk', [A, B]);
    assert.deepEqual(m.profileDrift(ps[0], [A, B]), []);
    const d = m.profileDrift(ps[0], [{...A, scale: 1}, {...B, x: 0}]);
    assert.deepEqual(d.map(x => x.field), ['scale', 'position']);
});
