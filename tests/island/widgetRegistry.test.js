import assert from 'node:assert/strict';
import {test} from 'node:test';

import {cellRect, clampSize, createHub, intersects, loadLayout, overlaps, pixelsToCells, serializeLayout, snapToGrid, validateWidgetManifest} from '../../shell/shared/widgetRegistry.js';

const mk = (id, provider = 'sys.cpu', intervalMs = 2000) => ({id, title: id, size: {min: {w: 1, h: 1}, max: {w: 4, h: 3}, default: {w: 2, h: 2}},
    refresh: {policy: 'interval', intervalMs}, provider, permissions: []});

test('manifest validation', () => {
    assert.equal(validateWidgetManifest(mk('cpu')).ok, true);
    const bad = fn => { const m = mk('cpu'); fn(m); return validateWidgetManifest(m); };
    assert.equal(bad(m => { m.id = 'Bad Id'; }).ok, false);
    assert.equal(bad(m => { m.refresh.intervalMs = 10; }).ok, false);
    assert.equal(bad(m => { m.refresh.policy = 'always'; }).ok, false);
    assert.equal(bad(m => { m.size.default = {w: 9, h: 1}; }).ok, false);
    assert.equal(bad(m => { m.size.min = {w: 5, h: 1}; }).ok, false);
    assert.equal(bad(m => { m.provider = ''; }).ok, false);
    assert.equal(bad(m => { m.permissions = ['root']; }).ok, false);
    assert.equal(validateWidgetManifest(null).ok, false);
});

test('hub shares one poll per provider and uses the shortest interval', () => {
    const hub = createHub();
    hub.subscribe('a', mk('a', 'sys.cpu', 5000));
    hub.subscribe('b', mk('b', 'sys.cpu', 2000));
    hub.subscribe('c', mk('c', 'sys.mem', 10000));
    assert.deepEqual(hub.due(0).sort(), ['sys.cpu', 'sys.mem']);
    hub.markRefreshed('sys.cpu', 0);
    hub.markRefreshed('sys.mem', 0);
    assert.deepEqual(hub.due(1999), []);
    assert.deepEqual(hub.due(2000), ['sys.cpu']);
    assert.equal(hub.nextDelay(1000), 1000);
    assert.equal(hub.nextDelay(2500), 0);
    assert.deepEqual(hub.subscribers('sys.cpu').sort(), ['a', 'b']);
});

test('nothing is due when every subscriber is hidden', () => {
    const hub = createHub();
    hub.subscribe('a', mk('a'));
    hub.subscribe('b', mk('b'));
    hub.setVisible('a', false);
    assert.deepEqual(hub.due(0), ['sys.cpu']);
    hub.setVisible('b', false);
    assert.deepEqual(hub.due(0), []);
    assert.equal(hub.nextDelay(0), null);
    hub.setVisible('b', true);
    assert.deepEqual(hub.due(0), ['sys.cpu']);
});

test('a failing widget is isolated and skipped', () => {
    const hub = createHub();
    hub.subscribe('a', mk('a', 'sys.cpu'));
    hub.subscribe('b', mk('b', 'sys.mem'));
    hub.reportError('a');
    assert.equal(hub.isErrored('a'), true);
    assert.deepEqual(hub.due(0), ['sys.mem']);
    assert.deepEqual(hub.subscribers('sys.cpu'), []);
    hub.clearError('a');
    assert.deepEqual(hub.due(0).sort(), ['sys.cpu', 'sys.mem']);
});

test('manual and event widgets never poll; bad manifests and overflow are refused', () => {
    const hub = createHub();
    const m = mk('a');
    m.refresh = {policy: 'manual'};
    assert.equal(hub.subscribe('a', m), true);
    assert.deepEqual(hub.due(0), []);
    assert.equal(hub.subscribe('x', {id: 'x'}), false);
    for (let i = 0; i < 60; i++) hub.subscribe(`w${i}`, mk(`w${i}`));
    assert.equal(hub.count(), 40);
    hub.unsubscribe('a');
    assert.equal(hub.count(), 39);
});

test('grid snapping and size clamping', () => {
    const grid = {cols: 12, rows: 8};
    assert.deepEqual(snapToGrid({x: 2.6, y: 1.2, w: 2.4, h: 1.6}, grid), {x: 3, y: 1, w: 2, h: 2});
    assert.deepEqual(snapToGrid({x: 11, y: 7, w: 4, h: 3}, grid), {x: 8, y: 5, w: 4, h: 3});
    assert.deepEqual(snapToGrid({x: -5, y: -5, w: 99, h: 0}, grid), {x: 0, y: 0, w: 12, h: 1});
    const m = mk('a');
    assert.deepEqual(clampSize({w: 9, h: 0}, m), {w: 4, h: 1});
    assert.deepEqual(clampSize({w: 4, h: 3}, m, grid, {x: 10, y: 0}), {w: 2, h: 3});
});

test('cell and pixel conversion round trips', () => {
    const cell = {w: 100, h: 80, gap: 10};
    const px = cellRect({x: 1, y: 2, w: 2, h: 1}, cell, {x: 50, y: 20});
    assert.deepEqual(px, {x: 160, y: 200, w: 210, h: 80});
    assert.deepEqual(pixelsToCells({x: 110, y: 180, w: 210, h: 80}, cell), {x: 1, y: 2, w: 2, h: 1});
});

test('overlap check reports the windows a widget would cover', () => {
    const widget = {x: 100, y: 100, w: 200, h: 100};
    const windows = [{x: 0, y: 0, w: 50, h: 50}, {x: 250, y: 150, w: 100, h: 100}, {x: 100, y: 100, w: 200, h: 100}];
    const o = overlaps(widget, windows);
    assert.deepEqual(o.map(x => x.index), [2, 1]);
    assert.equal(o[0].fraction, 1);
    assert.equal(o[1].area, 50 * 50);
    assert.deepEqual(overlaps(widget, []), []);
    assert.equal(intersects({x: 0, y: 0, w: 10, h: 10}, {x: 10, y: 0, w: 5, h: 5}), false);   // touching edges do not overlap
});

test('layout persistence is versioned and untrusted-input safe', () => {
    const grid = {cols: 12, rows: 8};
    const text = serializeLayout(grid, [{id: 'cpu-1', widget: 'cpu', x: 1, y: 1, w: 2, h: 2}]);
    assert.deepEqual(loadLayout(text), {grid, widgets: [{id: 'cpu-1', widget: 'cpu', x: 1, y: 1, w: 2, h: 2}], skipped: 0});
    assert.equal(loadLayout('nope').error, 'not valid JSON');
    assert.match(loadLayout(JSON.stringify({version: 99})).error, /version/);
    assert.match(loadLayout(JSON.stringify({version: 1, grid: {cols: 0, rows: 3}, widgets: []})).error, /grid/);
    const messy = JSON.stringify({version: 1, grid, widgets: [
        {id: 'a', widget: 'cpu', x: 0, y: 0, w: 2, h: 2},
        {id: 'a', widget: 'cpu', x: 4, y: 0, w: 2, h: 2},     // duplicate instance
        {id: 'b', widget: 'gone', x: 0, y: 4, w: 2, h: 2},    // not installed
        {id: 'c', widget: 'cpu', x: 'x', y: 0, w: 2, h: 2},   // junk
        {id: 'd', widget: 'cpu', x: 11, y: 7, w: 9, h: 9},    // too big: clamped then snapped
    ]});
    const r = loadLayout(messy, {cpu: mk('cpu')});
    assert.equal(r.skipped, 3);
    assert.deepEqual(r.widgets.map(w => w.id), ['a', 'd']);
    assert.deepEqual(r.widgets[1], {id: 'd', widget: 'cpu', x: 8, y: 5, w: 4, h: 3});
});
