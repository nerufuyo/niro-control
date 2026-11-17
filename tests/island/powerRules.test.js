// What the Power and Controls pages say about the battery and Wi-Fi: UPower's states, the time left, nmcli's list and its failures.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    batteryFacts, batteryState, batteryStatus, batteryTone, durationText, healthText, orderedProfiles, parseWifiList, pluggedIn,
    rateText, signalBars, wifiFailure,
} from '../../shell/island/build/src/powerRules.js';

test('UPower states become the island\'s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(batteryState),
        ['unknown', 'charging', 'discharging', 'discharging', 'full', 'idle', 'idle', 'unknown']);
});

test('the charger is in while charging, full or held', () => {
    assert.deepEqual(['charging', 'full', 'idle', 'discharging', 'unknown'].map(pluggedIn), [true, true, true, false, false]);
});

test('durations read in hours and minutes, and stay empty when unknown', () => {
    assert.equal(durationText(0), '');
    assert.equal(durationText(-5), '');
    assert.equal(durationText(20), 'under a minute');
    assert.equal(durationText(45 * 60), '45 min');
    assert.equal(durationText(3600), '1 h 00 min');
    assert.equal(durationText(3 * 3600 + 5 * 60), '3 h 05 min');
});

test('the status line says what the battery is doing and for how long', () => {
    assert.deepEqual(batteryStatus({state: 'charging', timeToFull: 4800, timeToEmpty: 0}), {title: 'Charging', detail: '1 h 20 min until full'});
    assert.deepEqual(batteryStatus({state: 'discharging', timeToFull: 0, timeToEmpty: 11100}), {title: 'On battery', detail: '3 h 05 min left'});
    assert.deepEqual(batteryStatus({state: 'discharging', timeToFull: 0, timeToEmpty: 0}), {title: 'On battery', detail: 'Estimating…'});
    assert.deepEqual(batteryStatus({state: 'full'}), {title: 'Fully charged', detail: 'Plugged in'});
    assert.deepEqual(batteryStatus({state: 'idle'}), {title: 'Plugged in', detail: 'Not charging'});
    assert.equal(batteryStatus({state: 'unknown'}).detail, '');
});

test('the level turns low only on battery, at the limit or under', () => {
    assert.equal(batteryTone(15, 'discharging'), 'low');
    assert.equal(batteryTone(20, 'discharging'), 'low');
    assert.equal(batteryTone(21, 'discharging'), 'normal');
    assert.equal(batteryTone(5, 'charging'), 'charging');
    assert.equal(batteryTone(100, 'full'), 'charging');
    assert.equal(batteryTone(5, 'idle'), 'normal');
});

test('health and power are shown only when known', () => {
    assert.equal(healthText(0), '');
    assert.equal(healthText(92.4), 'Health 92%');
    assert.equal(healthText(104), 'Health 100%');
    assert.equal(rateText(0.02), '');
    assert.equal(rateText(8.44), '8.4 W');
    assert.equal(batteryFacts({health: 92, rate: 8.44}), 'Health 92% · 8.4 W');
    assert.equal(batteryFacts({health: 0, rate: 0}), '');
});

test('the Wi-Fi list keeps one entry per name: the connected one, else the strongest, connected first', () => {
    const list = parseWifiList([
        ' :Cafe:40:WPA2', ' :Cafe:70:WPA2', '*:Home:55:WPA2', ' :Home:90:WPA2', ' :Guest:30:--', ' ::80:WPA2', ' :My\\:Net:60:WPA3',
    ].join('\n'));
    assert.deepEqual(list.map(n => n.ssid), ['Home', 'Cafe', 'My:Net', 'Guest']);
    assert.deepEqual(list.find(n => n.ssid === 'Home'), {ssid: 'Home', signal: 55, secure: true, active: true});
    assert.equal(list.find(n => n.ssid === 'Cafe').signal, 70);
    assert.equal(list.find(n => n.ssid === 'Guest').secure, false);
    assert.deepEqual(parseWifiList(null), []);
});

test('a refused password is told apart from other failures', () => {
    assert.deepEqual(wifiFailure('Error: Connection activation failed: (7) Secrets were required, but not provided.'),
        {wrongPassword: true, message: 'Wrong password'});
    assert.deepEqual(wifiFailure('Error: Connection activation failed: (4) Connection was not activated.\n'),
        {wrongPassword: true, message: 'Wrong password'});
    assert.deepEqual(wifiFailure('Error: Timeout expired (20 seconds)'), {wrongPassword: false, message: 'Timeout expired (20 seconds)'});
    assert.deepEqual(wifiFailure(''), {wrongPassword: false, message: 'Could not connect'});
});

test('signal reads as bars', () => {
    assert.deepEqual([0, 24, 25, 49, 50, 74, 75, 100].map(signalBars), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('profiles come in the order saver, balanced, performance', () => {
    assert.deepEqual(orderedProfiles(['performance', 'balanced', 'power-saver']), ['power-saver', 'balanced', 'performance']);
    assert.deepEqual(orderedProfiles(['balanced', 'performance']), ['balanced', 'performance']);
    assert.deepEqual(orderedProfiles(['custom', 'balanced']), ['balanced', 'custom']);
});
