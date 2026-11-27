// Tile's workspace glue (shell/tile/workspace.js) with a fake shell: groups, snapshots and monitor recovery, including the failure paths.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createWorkspaceService} from '../../shell/tile/workspace.js';
import * as groups from '../../shell/shared/windowGroups.js';
import * as snapshot from '../../shell/shared/snapshot.js';
import * as monitors from '../../shell/shared/monitorManager.js';

const MON = (index, x, extra = {}) => ({index, connector: `C${index}`, vendor: 'V', product: 'P', serial: `S${index}`, width: 1000, height: 800, scale: 1, x, y: 0, primary: index === 0, ...extra});

function fake({wins, mons = [MON(0, 0), MON(1, 1000)], recovery = true} = {}) {
    const files = {};
    const calls = {moved: [], focused: [], launched: [], switched: []};
    const state = {wins: wins ?? [], mons, nws: 3, focus: 0, recovery, now: 1_700_000_000_000, refuse: new Set()};
    const host = {
        liveWindows: () => state.wins.map(w => ({...w, rect: w.rect ?? {x: 100, y: 100, width: 300, height: 200}})),
        monitors: () => state.mons,
        nWorkspaces: () => state.nws, activeWorkspace: () => 1, focusedId: () => state.focus,
        moveWindow(id, to) {
            if (state.refuse.has(id)) throw new Error('refused');
            const w = state.wins.find(x => x.id === id);
            if (!w) return false;
            calls.moved.push({id, ...to});
            if (to.workspace !== null) w.workspace = to.workspace;
            if (to.monitor !== null) w.monitor = to.monitor;
            return true;
        },
        focusWindows: ids => calls.focused.push(ids), switchWorkspace: n => calls.switched.push(n),
        launch: appId => { calls.launched.push(appId); return appId === 'broken' ? {ok: false, reason: 'no desktop entry'} : {ok: true}; },
        load: name => (files[name] ? JSON.parse(files[name]) : null), save: (name, v) => { files[name] = JSON.stringify(v); },
        now: () => state.now, recoveryEnabled: () => state.recovery,
    };
    return {svc: createWorkspaceService({core: {groups, snapshot, monitors}, host}), files, calls, state};
}
const W = (id, appId, title, workspace = 1, monitor = 0) => ({id, appId, title, workspace, monitor});
const call = (svc, kind, op, args) => svc[kind](op, args ? JSON.stringify(args) : '');

test('groups: create from the focused window, add, rename, list', () => {
    const {svc, state, files} = fake({wins: [W(1, 'org.a.Edit', 'one'), W(2, 'org.b.Term', 'sh', 2, 1)]});
    state.focus = 1;
    const made = call(svc, 'groups', 'create', {name: 'Work'});
    assert.equal(made.ok, true);
    assert.equal(made.group.members.length, 1);
    assert.equal(made.group.target.workspace, 1);
    state.focus = 2;
    assert.equal(call(svc, 'groups', 'add', {id: 'work'}).group.members.length, 2);
    assert.equal(call(svc, 'groups', 'rename', {id: 'work', name: 'Job'}).group.name, 'Job');
    const list = call(svc, 'groups', 'list');
    assert.equal(list.groups[0].open, 2);
    assert.ok(files['tile-groups.json'], 'persisted as JSON');
});

test('groups: bad input is an error answer, not a throw', () => {
    const {svc} = fake({wins: []});
    assert.equal(call(svc, 'groups', 'create', {name: ''}).ok, false);
    assert.equal(call(svc, 'groups', 'add', {id: 'nope', windowId: 5}).ok, false);
    assert.equal(call(svc, 'groups', 'bogus').ok, false);
    assert.equal(svc.groups('list', '{not json').ok, false);
    assert.equal(svc.groups('list', '[1]').ok, false);
    assert.equal(call(svc, 'groups', 'delete', {id: 'zzz'}).ok, false);
});

test('groups: activate moves open members to the stored place, reports closed ones, focuses', () => {
    const {svc, state, calls} = fake({wins: [W(1, 'org.a.Edit', 'one'), W(2, 'org.b.Term', 'sh')]});
    state.focus = 1;
    call(svc, 'groups', 'create', {name: 'Work'});
    state.focus = 2;
    call(svc, 'groups', 'add', {id: 'work'});
    // the person scatters the windows, and closes the terminal
    state.wins[0].workspace = 3; state.wins[0].monitor = 1;
    state.wins = state.wins.filter(w => w.id !== 2);
    const preview = call(svc, 'groups', 'activate', {id: 'work', preview: true});
    assert.equal(preview.preview, true);
    assert.equal(preview.planned, 1);
    assert.equal(calls.moved.length, 0, 'a preview moves nothing');
    const r = call(svc, 'groups', 'activate', {id: 'work'});
    assert.equal(r.ok, true);
    assert.deepEqual(calls.moved.map(m => [m.id, m.workspace, m.monitor]), [[1, 1, 0]]);
    assert.equal(r.closed.length, 1, 'the closed terminal is reported');
    assert.equal(r.focused, true);
    assert.deepEqual(calls.focused[0], [1]);
    assert.deepEqual(calls.switched, [1]);
});

test('groups: a window the shell refuses to move is a partial failure, not an error', () => {
    const {svc, state} = fake({wins: [W(1, 'a.A', 'x'), W(2, 'b.B', 'y')]});
    state.focus = 1; call(svc, 'groups', 'create', {name: 'G'});
    state.focus = 2; call(svc, 'groups', 'add', {id: 'g'});
    state.wins.forEach(w => { w.workspace = 2; });
    state.refuse.add(2);
    const r = call(svc, 'groups', 'restore', {id: 'g'});
    assert.equal(r.ok, true);
    assert.equal(r.applied.length, 1);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].reason, 'refused');
});

test('groups: a target monitor that is gone is not an error and not forced', () => {
    const {svc, state, calls} = fake({wins: [W(1, 'a.A', 'x', 1, 1)]});
    state.focus = 1; call(svc, 'groups', 'create', {name: 'G'});
    state.mons = [MON(0, 0)];
    state.wins[0].monitor = 0; state.wins[0].workspace = 2;
    const r = call(svc, 'groups', 'activate', {id: 'g'});
    assert.equal(r.ok, true);
    assert.ok(r.notes.some(n => /not connected/.test(n)));
    assert.deepEqual(calls.moved.map(m => [m.workspace, m.monitor]), [[1, null]], 'only the workspace moved');
});

test('groups: delete and remember', () => {
    const {svc, state} = fake({wins: [W(1, 'a.A', 'x')]});
    state.focus = 1; call(svc, 'groups', 'create', {name: 'G'});
    state.wins[0].workspace = 3;
    assert.equal(call(svc, 'groups', 'remember', {id: 'g'}).group.target.workspace, 3);
    assert.equal(call(svc, 'groups', 'delete', {id: 'g'}).ok, true);
    assert.equal(call(svc, 'groups', 'list').groups.length, 0);
});

test('snapshots: take, list, diff against now, retain', () => {
    const {svc, state} = fake({wins: [W(1, 'org.a.Edit', 'one'), W(2, 'org.b.Term', 'sh', 2)]});
    const t = call(svc, 'snapshots', 'take', {name: 'Morning', pinned: true});
    assert.equal(t.ok, true);
    assert.equal(t.windows, 2);
    state.wins[0].workspace = 3;
    state.wins.push(W(3, 'org.c.New', 'n'));
    const id = call(svc, 'snapshots', 'list').snapshots[0].id;
    const d = call(svc, 'snapshots', 'diff', {a: id});
    assert.equal(d.diff.moved.length, 1);
    assert.equal(d.diff.added.length, 1);
    state.now += 400 * 864e5;
    state.wins = [];
    call(svc, 'snapshots', 'take', {name: 'Later'});
    const kept = call(svc, 'snapshots', 'list').snapshots;
    assert.ok(kept.some(s => s.name === 'Morning'), 'a pinned snapshot outlives the age limit');
    assert.equal(call(svc, 'snapshots', 'retain', {max: 1, days: 1}).ok, true);
});

test('snapshots: plan separates place, relaunch and unsupported; restore needs confirm and never closes', () => {
    const {svc, state, calls} = fake({wins: [W(1, 'org.a.Edit', 'one', 1, 0), W(2, 'org.b.Term', 'sh', 2, 1), W(3, '', 'mystery', 1, 0)]});
    call(svc, 'snapshots', 'take', {name: 'S'});
    const id = call(svc, 'snapshots', 'list').snapshots[0].id;
    state.wins[0].workspace = 3;                          // moved since
    state.wins = state.wins.filter(w => w.id !== 2);      // the terminal was closed
    const plan = call(svc, 'snapshots', 'plan', {id});
    assert.deepEqual(plan.counts, {place: 1, relaunch: 1, unsupported: 1});
    const preview = call(svc, 'snapshots', 'restore', {id});
    assert.equal(preview.preview, true);
    assert.equal(calls.moved.length, 0);
    const r = call(svc, 'snapshots', 'restore', {id, confirm: true});
    assert.equal(r.preview, false);
    assert.deepEqual(calls.moved.map(m => [m.id, m.workspace]), [[1, 1]]);
    assert.deepEqual(calls.launched, [], 'restoring never launches');
    assert.match(r.note, /nothing is closed/);
    assert.match(r.note, /not saved or restored/);
});

test('snapshots: launch only an app the snapshot would relaunch', () => {
    const {svc, state, calls} = fake({wins: [W(1, 'org.a.Edit', 'one'), W(2, 'broken', 'b')]});
    call(svc, 'snapshots', 'take', {});
    const id = call(svc, 'snapshots', 'list').snapshots[0].id;
    state.wins = [state.wins[0]];
    assert.equal(call(svc, 'snapshots', 'launch', {id, appId: 'org.a.Edit'}).ok, false, 'running apps are not relaunched');
    assert.equal(call(svc, 'snapshots', 'launch', {id, appId: 'evil.App'}).ok, false, 'an app not in the snapshot is refused');
    const bad = call(svc, 'snapshots', 'launch', {id, appId: 'broken'});
    assert.equal(bad.ok, false);
    assert.match(bad.error, /no desktop entry/);
    state.wins = [];
    state.wins.push(W(9, 'x.X', 'x'));
    assert.equal(call(svc, 'snapshots', 'launch', {id, appId: 'org.a.Edit'}).launched, 'org.a.edit');
    assert.deepEqual(calls.launched, ['broken', 'org.a.edit']);
});

test('snapshots: a window moves to a workspace that no longer exists is clamped; two windows of one app are not guessed', () => {
    const {svc, state} = fake({wins: [W(1, 'a.A', 'one', 3), W(2, 'a.A', 'two', 1), W(3, 'b.B', 'b', 3)]});
    call(svc, 'snapshots', 'take', {});
    const id = call(svc, 'snapshots', 'list').snapshots[0].id;
    state.nws = 2;
    state.wins[0].title = 'renamed-1'; state.wins[1].title = 'renamed-2';   // titles no longer identify them
    const plan = call(svc, 'snapshots', 'plan', {id});
    assert.ok(plan.items.filter(i => i.appId === 'a.a').every(i => i.action === 'skip'), 'ambiguous windows are skipped');
    const b = plan.items.find(i => i.appId === 'b.b');
    assert.equal(b.workspace, 2);
    assert.match(b.note, /gone/);
});

test('snapshots: a corrupt stored snapshot is counted, not fatal', () => {
    const {svc, files} = fake({wins: []});
    files['tile-snapshots.json'] = JSON.stringify({version: 1, snapshots: [{id: 'x', windows: 'no'}, {id: 'old', version: 1, at: 1, windows: [{app: 'a.A', workspace: 2, monitor: 0}], pinned: true}]});
    const l = call(svc, 'snapshots', 'list');
    assert.equal(l.invalid, 1);
    assert.equal(l.snapshots[0].windows, 1, 'a v1 snapshot is migrated');
});

test('monitor recovery: off does nothing; on moves windows off a vanished monitor and back when it returns', () => {
    const {svc, state, calls} = fake({wins: [W(1, 'a.A', 'x', 1, 1)]});
    state.wins[0].rect = {x: 1200, y: 100, width: 300, height: 200};
    state.recovery = false;
    svc.noteWindows();
    state.mons = [MON(0, 0)];
    assert.match(svc.monitorsChanged().skipped, /off/);
    assert.equal(calls.moved.length, 0);
    // enabled
    state.recovery = true; state.mons = [MON(0, 0), MON(1, 1000)];
    svc.monitorsChanged();                           // sees it return while off: nothing remembered
    svc.noteWindows();
    state.mons = [MON(0, 0)];
    state.wins[0].monitor = 0;                       // mutter already moved it
    const gone = svc.monitorsChanged();
    assert.equal(gone.event.relocated, 1);
    assert.deepEqual(svc.monitorStatus().remembered, {[`C1|V|P|${monitors.hashSerial('S1')}`]: 1});
    assert.equal(calls.moved.at(-1).monitor, 0);
    state.wins[0].rect = {x: 50, y: 50, width: 300, height: 200};
    state.mons = [MON(0, 0), MON(1, 1000)];
    const back = svc.monitorsChanged();
    assert.equal(back.event.restored, 1);
    const last = calls.moved.at(-1);
    assert.equal(last.monitor, 1);
    assert.equal(last.rect.x, 1000 + 200, 'back at its old place on the returning monitor');
    assert.deepEqual(svc.monitorStatus().remembered, {});
});

test('monitor recovery: a window closed meanwhile is not an error; no monitor change is a no-op; the last monitor leaving moves nothing', () => {
    const {svc, state} = fake({wins: [W(1, 'a.A', 'x', 1, 1)]});
    svc.noteWindows();
    assert.equal(svc.monitorsChanged().changed, false);
    state.wins = [];
    state.mons = [MON(0, 0)];
    assert.equal(svc.monitorsChanged().event.relocated, 0);
    state.mons = [MON(0, 0), MON(1, 1000)];
    assert.equal(svc.monitorsChanged().ok, true);
    state.mons = [];
    assert.equal(svc.monitorsChanged().ok, true);
});

test('the API answer is versioned', () => {
    const {svc} = fake();
    const a = svc.api();
    assert.equal(a.api, 1);
    assert.ok(a.groups.includes('activate') && a.snapshots.includes('restore'));
});

test('stored files: a damaged one is refused and not overwritten; invalid entries survive every save', () => {
    const {svc, files} = fake({wins: [W(1, 'a.A', 'x')]});
    for (const damaged of ['{"groups": [', 'null_', '[]', '{"version":1}']) {
        files['tile-groups.json'] = files['tile-snapshots.json'] = damaged;
        assert.match(call(svc, 'groups', 'create', {name: 'G'}).error, /tile-groups\.json could not be read/);
        assert.match(call(svc, 'snapshots', 'take', {}).error, /tile-snapshots\.json could not be read/);
        assert.equal(files['tile-groups.json'], damaged);
        assert.equal(files['tile-snapshots.json'], damaged);
    }
    const badSnap = {id: 'future', version: 9, windows: []}, badGroup = {id: 7};
    files['tile-groups.json'] = JSON.stringify({version: 1, groups: [badGroup]});
    files['tile-snapshots.json'] = JSON.stringify({version: 1, snapshots: [badSnap]});
    const kept = (file, key, bad) => assert.deepEqual(JSON.parse(files[file])[key].at(-1), bad);
    call(svc, 'groups', 'create', {name: 'G', windowIds: [1]});
    kept('tile-groups.json', 'groups', badGroup);
    call(svc, 'groups', 'delete', {id: 'g'});
    kept('tile-groups.json', 'groups', badGroup);
    const {id} = call(svc, 'snapshots', 'take', {}).snapshot;
    for (const [op, args] of [['pin', {id}], ['retain', {}], ['delete', {id}]]) {
        assert.equal(call(svc, 'snapshots', op, args).ok, true);
        kept('tile-snapshots.json', 'snapshots', badSnap);
    }
});
