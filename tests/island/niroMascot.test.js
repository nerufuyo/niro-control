// What mood Niro the slime is in on the Niro Device page, from what island-daemon says.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {GREETING_MS, LOW_BATTERY, baseMood, greetingFor, summarize} from '../../shell/island/build/src/niroMascotRules.js';

const device = (online, battery) => ({device_id: 'a', name: 'Desk', online, status: battery === undefined ? null : {battery}});

test('no device yet: curious', () => {
    assert.equal(baseMood(summarize({devices: [], pairing: {active: false}, request: {pending: false}})), 'curious');
    assert.equal(baseMood(summarize({})), 'curious');
});

test('a code is open: listening; a device is asking: alert, which wins', () => {
    assert.equal(baseMood(summarize({devices: [], pairing: {active: true}})), 'listening');
    assert.equal(baseMood(summarize({devices: [], pairing: {active: true}, request: {pending: true}})), 'alert');
    assert.equal(baseMood(summarize({devices: [device(true)], request: {pending: true}})), 'alert');
});

test('a device here is calm; devices but none here is sad', () => {
    assert.equal(baseMood(summarize({devices: [device(true, 80)]})), 'idle');
    assert.equal(baseMood(summarize({devices: [device(false, 80)]})), 'sad');
    assert.equal(baseMood(summarize({devices: [device(false), device(true)]})), 'idle');
});

test('a low battery tires it; an unknown one (255) does not', () => {
    assert.equal(baseMood(summarize({devices: [device(true, LOW_BATTERY)]})), 'sleepy');
    assert.equal(baseMood(summarize({devices: [device(true, LOW_BATTERY + 1)]})), 'idle');
    assert.equal(baseMood(summarize({devices: [device(true, 255)]})), 'idle');
    assert.equal(baseMood(summarize({devices: [device(true, null)]})), 'idle');
});

test('a low battery on a device that is away does not count', () => {
    assert.equal(baseMood(summarize({devices: [device(false, 5)]})), 'sad');
});

test('a device coming online is greeted with a smile, a newly paired one with love', () => {
    const away = summarize({devices: [device(false)]});
    const here = summarize({devices: [device(true)]});
    assert.equal(greetingFor(away, here), 'happy');
    assert.equal(greetingFor(here, here), null);
    assert.equal(greetingFor(here, away), null);
    const none = summarize({devices: [], pairing: {active: true}});
    assert.equal(greetingFor(none, summarize({devices: [device(true)]})), 'love');
    const asking = summarize({devices: [], request: {pending: true}});
    assert.equal(greetingFor(asking, summarize({devices: [device(true)]})), 'love');
});

test('the first look at the state greets nobody', () => {
    assert.equal(greetingFor(null, summarize({devices: [device(true)]})), null);
});

test('a device the user paired before is not "newly paired" when it merely comes online', () => {
    const away = summarize({devices: [device(false)]});
    assert.equal(greetingFor(away, summarize({devices: [device(true)]})), 'happy');
});

test('a greeting is short', () => {
    assert.ok(GREETING_MS >= 2000 && GREETING_MS <= 6000);
});

test('malformed state is read as nothing, not as a crash', () => {
    for (const bad of [{devices: 'x'}, {devices: [null]}, {devices: [{}]}, {pairing: null, request: null}])
        assert.doesNotThrow(() => baseMood(summarize(bad)));
});
