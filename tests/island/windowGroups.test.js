// Window groups and workspace memory core (vNext 7.4, 7.5): plans only, vanished windows and monitors handled.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import * as g from '../../shell/shared/windowGroups.js';

const live = [
    {id: 1, appId: 'Firefox', title: 'Docs - Mozilla', workspace: 0, monitor: 'A'},
    {id: 2, appId: 'code', title: 'main.rs', workspace: 0, monitor: 'A'},
    {id: 3, appId: 'code', title: 'lib.rs', workspace: 1, monitor: 'B'},
    {id: 4, appId: 'term', title: 'bash', workspace: 1, monitor: 'B'},
];

test('create, rename, add, remove and delete groups; names are unique and bounded', () => {
    let {store, group} = g.createGroup(g.emptyStore(), 'Work', [live[0], live[1]]);
    assert.equal(group.id, 'work'); assert.equal(group.members.length, 2);
    assert.throws(() => g.createGroup(store, 'work'), /exists/);
    assert.throws(() => g.createGroup(store, '  '), /name/);
    store = g.renameGroup(store, 'work', 'Office');
    assert.equal(store.groups[0].name, 'Office');
    assert.throws(() => g.renameGroup(store, 'nope', 'x'), /no group/);
    store = g.addWindow(store, 'work', live[3]);
    store = g.addWindow(store, 'work', live[3]);
    assert.equal(store.groups[0].members.length, 3, 'no duplicate');
    store = g.removeWindow(store, 'work', {id: 2});
    store = g.removeWindow(store, 'work', {appId: 'FIREFOX', title: 'Docs - Mozilla'});
    assert.deepEqual(store.groups[0].members.map(m => m.appId), ['term']);
    assert.equal(g.deleteGroup(store, 'work').groups.length, 0);
    assert.equal(store.groups.length, 1, 'input is not mutated');
    let big = g.emptyStore();
    for (let i = 0; i < g.MAX_GROUPS; i++) big = g.createGroup(big, `g${i}`).store;
    assert.throws(() => g.createGroup(big, 'one more'), /too many/);
});

test('matching: id, exact title, partial title, sole window of the app, and safe refusals', () => {
    const m = a => g.matchWindow(a, live);
    assert.equal(m({appId: 'firefox', title: '', windowId: 1}).id, 1);
    assert.equal(m({appId: 'code', title: 'lib.rs', windowId: 99}).id, 3);
    assert.equal(m({appId: 'code', title: 'lib', windowId: null}).id, 3);
    assert.equal(m({appId: 'firefox', title: 'renamed', windowId: null}).id, 1, 'only firefox window');
    assert.equal(m({appId: 'code', title: 'other', windowId: null}), null, 'ambiguous');
    assert.equal(m({appId: 'term', title: '', windowId: 2}).id, 4, 'a reused id of another app is not trusted');
    assert.equal(m({appId: 'gone', title: 'x', windowId: 1}), null);
    assert.equal(g.matchWindow({appId: 'code', title: 'main.rs', windowId: null}, live, new Set([2])), null, 'taken windows are skipped');
});

test('planMove moves only what is not there yet and reports missing windows', () => {
    const {group} = g.createGroup(g.emptyStore(), 'W', [live[0], live[1], live[2], {id: 77, appId: 'closed', title: 'x'}]);
    const p = g.planMove(group, {workspace: 0, monitor: 'A'}, live, ['A', 'B']);
    assert.deepEqual(p.moves.map(x => x.windowId), [3]);
    assert.equal(p.missing.length, 1);
    assert.equal(p.redirected, false);
});

test('planMove to a vanished monitor keeps the monitor and says so', () => {
    const {group} = g.createGroup(g.emptyStore(), 'W', [live[0]]);
    const p = g.planMove(group, {workspace: 2, monitor: 'GONE'}, live, ['A']);
    assert.deepEqual(p.moves, [{windowId: 1, workspace: 2, monitor: null}]);
    assert.equal(p.redirected, true); assert.match(p.notes[0], /not connected/);
});

test('restorePlan uses the stored target and is empty without one', () => {
    let {store, group} = g.createGroup(g.emptyStore(), 'W', [live[2]]);
    assert.match(g.restorePlan(group, live).notes[0], /no target/);
    store = g.setTarget(store, 'w', {workspace: 0, monitor: 'A'});
    assert.equal(g.restorePlan(store.groups[0], live, ['A']).moves.length, 1);
});

test('layout capture and restore: size kept, vanished monitor and workspace fall back, rect clamped on screen', () => {
    const wins = [{...live[1], rect: {x: 1900, y: 100, width: 1000, height: 700}}, {...live[3], workspace: 5, rect: {x: 0, y: 0, width: 500, height: 400}}];
    const layout = g.captureLayout(wins, {name: 'Dev', at: 5});
    assert.equal(layout.entries[0].rect.width, 1000);
    const monitors = [{key: 'P', primary: true, workArea: {x: 0, y: 0, width: 1280, height: 720}}];
    const live2 = [live[1], live[3], {id: 9, appId: 'new', title: 'z', workspace: 0, monitor: 'P'}];
    const plan = g.planRestore({...layout, entries: [...layout.entries, {appId: 'closed', title: 'q', windowId: null, workspace: 0, monitor: 'A', rect: null}]}, live2, monitors, {workspaces: 2});
    assert.equal(plan.actions.length, 2);
    const [a, b] = plan.actions;
    assert.equal(a.monitor, 'P'); assert.equal(a.fellBack, true);
    assert.ok(a.rect.x + a.rect.width <= 1280 && a.rect.y + a.rect.height <= 720);
    assert.equal(b.workspace, 1);
    assert.deepEqual(plan.missing.map(m => m.appId), ['closed']);
    assert.ok(plan.notes.length >= 2);
});

test('restore with a matching monitor leaves the monitor alone, and with none connected does not throw', () => {
    const layout = g.captureLayout([{...live[0], rect: {x: 10, y: 10, width: 300, height: 200}}]);
    const ok = g.planRestore(layout, live, [{key: 'A', workArea: {x: 0, y: 0, width: 1920, height: 1080}}]);
    assert.equal(ok.actions[0].fellBack, false); assert.deepEqual(ok.actions[0].rect, {x: 10, y: 10, width: 300, height: 200});
    const none = g.planRestore(layout, live, []);
    assert.equal(none.actions[0].monitor, null);
});

test('layouts are kept by name, newest first and capped', () => {
    let ls = [];
    for (let i = 0; i < 12; i++) ls = g.saveLayout(ls, {name: `l${i}`, entries: []});
    assert.equal(ls.length, 10); assert.equal(ls[0].name, 'l11');
    ls = g.saveLayout(ls, {name: 'l5', entries: [1]});
    assert.equal(ls[0].name, 'l5'); assert.equal(ls.filter(l => l.name === 'l5').length, 1);
});

test('layout capture is capped', () => {
    const many = Array.from({length: 500}, (_, i) => ({id: i, appId: 'a', title: 't', workspace: 0}));
    assert.equal(g.captureLayout(many).entries.length, g.MAX_LAYOUT);
});
