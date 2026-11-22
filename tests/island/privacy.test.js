// Privacy Dashboard core (vNext 26).
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createPrivacy, describeSupport, permissionOverview} from '../../shell/shared/privacy.js';

const full = {wayland: true, audioServer: true, cameraProbe: true, recorderSignal: true};

test('indicators report who is using what', () => {
    const p = createPrivacy({caps: full});
    const m = p.observe([{kind: 'mic', app: 'Zoom'}, {kind: 'camera', app: 'Zoom'}], 0);
    assert.equal(m.indicators.mic.state, 'active');
    assert.deepEqual(m.indicators.mic.apps, ['Zoom']);
    assert.equal(m.indicators['screen-share'].state, 'inactive');
    assert.equal(m.anyActive, true);
});

test('unsupported indicators say unknown with a reason, never "inactive"', () => {
    const p = createPrivacy({caps: {wayland: false, audioServer: true}});
    const m = p.observe([{kind: 'screen-share', app: 'x'}, {kind: 'camera', app: 'y'}], 0);
    assert.equal(m.indicators['screen-share'].supported, false);
    assert.equal(m.indicators['screen-share'].state, 'unknown');
    assert.match(m.indicators['screen-share'].explanation, /X11/);
    assert.equal(m.indicators.camera.state, 'unknown');
    assert.equal(m.anyActive, false);                       // an event on an unsupported indicator is not trusted
    assert.equal(describeSupport({}).mic.supported, false);
});

test('level meters are ignored for the microphone', () => {
    const p = createPrivacy({caps: full});
    assert.equal(p.observe([{kind: 'mic', app: 'org.gnome.VolumeControl'}], 0).indicators.mic.state, 'inactive');
});

test('history is off by default, opt-in, bounded, clearable, and cleared when switched off', () => {
    const p = createPrivacy({caps: full});
    p.observe([{kind: 'mic', app: 'A'}], 0);
    assert.deepEqual(p.history(), []);
    p.setHistory(true);
    p.observe([{kind: 'mic', app: 'A'}], 10);
    p.observe([{kind: 'mic', app: 'A'}], 20);                // same session: one entry
    p.observe([], 30);
    assert.deepEqual(p.history(), [{kind: 'mic', app: 'A', start: 10, end: 30}]);
    p.clearHistory();
    assert.equal(p.history().length, 0);
    p.observe([{kind: 'camera', app: 'B'}], 40);
    p.setHistory(false);
    assert.equal(p.history().length, 0);
    p.setHistory(true);
    for (let i = 0; i < 300; i++) {
        p.observe([{kind: 'mic', app: `app${i}`}], i * 2);
        p.observe([], i * 2 + 1);
    }
    assert.ok(p.history().length <= 200);
    assert.deepEqual(Object.keys(p.history()[0]).sort(), ['app', 'end', 'kind', 'start']);   // no content, no arguments
});

test('permission overview from plain input', () => {
    const o = permissionOverview([
        {app: 'Zoom', mic: 'granted', camera: 'granted', screen: 'ask'},
        {app: 'Browser', mic: 'denied'},
        {app: 'Alpha', camera: 'granted'},
        {bad: true},
    ]);
    assert.deepEqual(o.rows.map(r => r.app), ['Zoom', 'Alpha', 'Browser']);
    assert.equal(o.rows[0].location, 'unknown');
    assert.deepEqual(o.counts.mic, {granted: 1, denied: 1, unknown: 1});
    assert.deepEqual(permissionOverview(null).rows, []);
});
