// What the Niro Device page says of a pairing code and of a device.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {CODE_KEEP_MS, codeKept, deviceStatus, formatCode, formatLeft} from '../../shell/island/build/src/niroDeviceRules.js';

test('a code is read in two halves of three', () => {
    assert.equal(formatCode('123456'), '123 456');
    assert.equal(formatCode('000042'), '000 042');
});

test('anything that is not six digits is shown as it is', () => {
    assert.equal(formatCode(''), '');
    assert.equal(formatCode('12345'), '12345');
    assert.equal(formatCode('1234567'), '1234567');
});

test('the time left counts down as m:ss, rounded up, and stops at zero', () => {
    assert.equal(formatLeft(120), '2:00');
    assert.equal(formatLeft(107.2), '1:48');
    assert.equal(formatLeft(59), '0:59');
    assert.equal(formatLeft(0.2), '0:01');
    assert.equal(formatLeft(0), '0:00');
    assert.equal(formatLeft(-5), '0:00');
});

test('a device offline says so, whatever it last said', () => {
    assert.equal(deviceStatus({online: false, status: {battery: 50}}), 'Offline');
    assert.equal(deviceStatus({online: false, status: null}), 'Offline');
});

test('a device online says its battery when it told, and that it charges', () => {
    assert.equal(deviceStatus({online: true, status: null}), 'Online');
    assert.equal(deviceStatus({online: true}), 'Online');
    assert.equal(deviceStatus({online: true, status: {battery: 78, charging: false}}), 'Online · 78%');
    assert.equal(deviceStatus({online: true, status: {battery: 12, charging: true}}), 'Online · 12% · charging');
    assert.equal(deviceStatus({online: true, status: {fw: '0.1.0'}}), 'Online');
});

test('a battery the device does not read (255) is not shown as a level', () => {
    assert.equal(deviceStatus({online: true, status: {battery: 255, charging: false}}), 'Online');
    assert.equal(deviceStatus({online: true, status: {battery: 100, charging: false}}), 'Online · 100%');
    assert.equal(deviceStatus({online: true, status: {battery: 101, charging: false}}), 'Online');
});

test('a code handed over before the island hears it is open is kept', () => {
    const base = {code: '123456', seenOpen: false, now: 1000, until: 126000};
    assert.deepEqual(codeKept({...base, open: false}), {code: '123456', seenOpen: false});
});

test('once it was open, the code is dropped when it is not any more', () => {
    const base = {code: '123456', now: 5000, until: 126000};
    assert.deepEqual(codeKept({...base, seenOpen: false, open: true}), {code: '123456', seenOpen: true});
    assert.deepEqual(codeKept({...base, seenOpen: true, open: true}), {code: '123456', seenOpen: true});
    assert.deepEqual(codeKept({...base, seenOpen: true, open: false}), {code: null, seenOpen: false});
});

test('a code past its time is dropped, open or not, and no code stays none', () => {
    assert.deepEqual(codeKept({code: '123456', seenOpen: true, open: true, now: 126001, until: 126000}), {code: null, seenOpen: false});
    assert.deepEqual(codeKept({code: '123456', seenOpen: false, open: false, now: 126001, until: 126000}), {code: null, seenOpen: false});
    assert.deepEqual(codeKept({code: null, seenOpen: true, open: true, now: 1, until: 126000}), {code: null, seenOpen: false});
    assert.ok(CODE_KEEP_MS > 120000);
});
