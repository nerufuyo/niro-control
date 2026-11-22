// Universal HUD core (vNext 22).
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createHud, normalizeConfig, DEFAULT_CONFIG} from '../../shell/shared/hud.js';

test('config is normalized and bounded; unknown values fall back', () => {
    const c = normalizeConfig({position: 'nowhere', opacity: 9, duration: 5, size: 'large', monitor: -3, maxVisible: 99});
    assert.equal(c.position, DEFAULT_CONFIG.position);
    assert.equal(c.opacity, 1);
    assert.equal(c.duration, 500);
    assert.equal(c.monitor, 'focused');
    assert.equal(c.maxVisible, 5);
    assert.equal(normalizeConfig({monitor: 2}).monitor, 2);
});

test('same kind updates instead of stacking and extends the expiry', () => {
    const h = createHud({duration: 1000});
    assert.equal(h.show('volume', {value: 0.3}, 0).action, 'created');
    assert.equal(h.show('volume', {value: 0.5}, 400).action, 'updated');
    const v = h.view(500);
    assert.equal(v.items.length, 1);
    assert.equal(v.items[0].value, 0.5);
    assert.equal(h.view(1399).items.length, 1);        // expiry moved to 1400
    assert.equal(h.view(1400).items.length, 0);
});

test('custom HUDs dedupe by key, unknown kinds are dropped, text is capped', () => {
    const h = createHud();
    assert.equal(h.show('custom', {key: 'a', label: 'x'.repeat(500)}, 0).action, 'created');
    assert.equal(h.show('custom', {key: 'b'}, 0).action, 'created');
    assert.equal(h.view(0).items[0].label.length, 80);
    assert.equal(h.show('custom', {key: 'a'}, 1).action, 'updated');
    assert.equal(h.show('nope', {}, 0).action, 'dropped');
    assert.equal(h.view(2).items.length, 2);
});

test('queue: max visible, promotion on expiry, queue cap, urgent replaces', () => {
    const h = createHud({duration: 1000, maxVisible: 2});
    h.show('volume', {}, 0); h.show('brightness', {}, 0);
    assert.equal(h.show('mic', {}, 0).action, 'queued');
    assert.equal(h.view(10).queued, 1);
    assert.equal(h.show('battery', {urgent: true}, 10).action, 'created');
    assert.equal(h.view(10).items.length, 2);
    const after = h.view(1100);
    assert.deepEqual(after.items.map(i => i.kind), ['mic']);       // queued item promoted, others expired
    const q = createHud({maxVisible: 1});
    q.show('volume', {}, 0);
    const kinds = ['brightness', 'mic', 'media', 'battery', 'power-profile', 'bluetooth', 'network', 'custom'];
    const r = kinds.map(k => q.show(k, {key: k}, 0).action);
    assert.equal(r.filter(a => a === 'queued').length, 8);
    assert.equal(q.show('custom', {key: 'z'}, 0).action, 'dropped');
});

test('click-through is always true and cannot be configured away', () => {
    const h = createHud({clickThrough: false});
    h.show('volume', {}, 0);
    assert.equal(h.view(0).clickThrough, true);
    h.configure({clickThrough: false});
    assert.equal(h.view(0).clickThrough, true);
});

test('reduced motion gives zero animation durations; normal motion does not', () => {
    const still = createHud({motion: {reduced: true}});
    assert.deepEqual(still.view(0).animation, {in: 0, out: 0, animated: false});
    const moving = createHud({motion: {preset: 'smooth'}});
    assert.equal(moving.view(0).animation.animated, true);
    assert.ok(moving.view(0).animation.in > 0);
    moving.configure({motion: {reduced: true}});
    assert.equal(moving.view(0).animation.in, 0);
});

test('suppress GNOME OSD only applies to kinds GNOME draws, and only when on', () => {
    const h = createHud();
    assert.equal(h.suppressNative('volume'), false);
    h.configure({suppressGnomeOsd: true});
    assert.equal(h.suppressNative('volume'), true);
    assert.equal(h.suppressNative('brightness'), true);
    assert.equal(h.suppressNative('battery'), false);
});

test('nextExpiry lets the caller arm one timer; compact forces small', () => {
    const h = createHud({duration: 1000, compact: true});
    assert.equal(h.nextExpiry(), null);
    h.show('volume', {}, 100);
    h.show('mic', {}, 300);
    assert.equal(h.nextExpiry(), 1100);
    assert.equal(h.view(300).size, 'small');
    h.clear();
    assert.equal(h.view(300).items.length, 0);
});
