// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The timer's typed lengths: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {typedMinutes, Stopwatch, stopwatchText} from '../../shell/island/build/src/timerRules.js';

test('a typed length is kept within its stepper', () => {
    assert.equal(typedMinutes('45', 1, 180), 45);
    assert.equal(typedMinutes(' 7 ', 1, 60), 7);
    assert.equal(typedMinutes('0', 1, 180), 1);
    assert.equal(typedMinutes('240', 1, 180), 180);
});

test('anything but digits is no length', () => {
    assert.equal(typedMinutes('', 1, 180), null);
    assert.equal(typedMinutes('4m', 1, 180), null);
    assert.equal(typedMinutes('+5', 1, 180), null);
    assert.equal(typedMinutes('–', 1, 180), null);
});

test('stopwatch: readings, running, pausing, laps', () => {
    assert.equal(stopwatchText(0), '0:00');
    assert.equal(stopwatchText(59999), '0:59');
    assert.equal(stopwatchText(61000), '1:01');
    assert.equal(stopwatchText(3600000 + 5 * 60000 + 7000), '1:05:07');
    const w = new Stopwatch();
    assert.equal(w.lap(500), null);
    w.toggle(1000);
    assert.equal(w.running, true);
    assert.equal(w.elapsed(4000), 3000);
    assert.deepEqual(w.lap(4000), {n: 1, total: 3000, split: 3000});
    assert.deepEqual(w.lap(10000), {n: 2, total: 9000, split: 6000});
    w.toggle(12000);
    assert.equal(w.elapsed(99000), 11000);
    w.toggle(20000);
    assert.equal(w.elapsed(21000), 12000);
    w.reset();
    assert.equal(w.elapsed(30000), 0);
    assert.deepEqual(w.laps, []);
});
