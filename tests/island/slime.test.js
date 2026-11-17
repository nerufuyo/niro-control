// Niro the slime: its moods, its spring, its manners, and that it sleeps when it is calm.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ACTS, DOZE_AFTER, MOODS, Slime, poseFor} from '../../shell/island/build/src/slime.js';

const finite = value => assert.ok(Number.isFinite(value), `${value} is a number`);
const allFinite = frame => {
    for (const key of ['rx', 'ry', 'ground', 'cx', 'shear', 'shut', 'arch', 'curve', 'open', 'lidL', 'lidR', 'gx', 'gy', 'blink', 'bubble'])
        finite(frame[key]);
    for (const value of Object.values(frame.pose))
        finite(value);
};

test('every mood has a pose, and a frame of every mood is made of numbers', () => {
    for (const mood of MOODS) {
        const slime = new Slime(5);
        slime.setMood(mood);
        slime.step(3);
        assert.equal(slime.mood, mood);
        allFinite(slime.frame());
        assert.ok(Object.keys(poseFor(mood)).length > 10);
    }
});

test('an unknown mood is refused, not stored', () => {
    const slime = new Slime(1);
    slime.setMood('angry');
    assert.equal(slime.mood, 'waking');
});

test('a minute of animation in any mood stays finite and inside its limits', () => {
    for (const mood of MOODS) {
        const slime = new Slime(11);
        slime.setMood(mood);
        for (let i = 0; i < 1800; i++) {
            slime.step(1 / 30);
            if (i % 350 === 0) slime.poke();
            const f = slime.frame();
            allFinite(f);
            assert.ok(f.rx > 40 && f.rx < 130, `${mood}: width ${f.rx}`);
            assert.ok(f.ry > 30 && f.ry < 90, `${mood}: height ${f.ry}`);
            assert.ok(f.lift >= 0 && f.lift < 120, `${mood}: lift ${f.lift}`);
        }
    }
});

test('one long step is as safe as many small ones', () => {
    const slime = new Slime(3);
    slime.setMood('happy');
    slime.step(600);
    allFinite(slime.frame());
    const f = slime.frame();
    assert.ok(f.rx < 130 && f.ry > 30);
});

test('the same seed gives the same slime, another seed another', () => {
    const run = seed => {
        const slime = new Slime(seed);
        slime.setMood('idle');
        const seen = [];
        for (let i = 0; i < 600; i++) { slime.step(1 / 30); seen.push(slime.frame().gx.toFixed(3)); }
        return seen.join();
    };
    assert.equal(run(7), run(7));
    assert.notEqual(run(7), run(8));
});

test('a landing squashes it and the wobble dies away', () => {
    const slime = new Slime(2);
    slime.setMood('idle');
    slime.step(2);
    const rest = slime.frame().rx;
    slime.hop(300);
    let widest = rest;
    for (let i = 0; i < 40; i++) { slime.step(1 / 30); widest = Math.max(widest, slime.frame().rx); }
    assert.ok(widest > rest + 3, `it spread on landing (${widest} against ${rest})`);
    slime.step(4);
    assert.ok(Math.abs(slime.frame().rx - rest) < 1.5, 'and settled again');
    assert.equal(slime.frame().lift, 0);
});

test('a hop only starts from the ground', () => {
    const slime = new Slime(2);
    slime.setMood('idle');
    slime.hop(300);
    slime.step(0.05);
    const speed = slime.hv;
    slime.hop(500);
    assert.equal(slime.hv, speed, 'a second hop in the air is ignored');
});

test('a calm slime needs no frames, and says when it will next stir', () => {
    const slime = new Slime(4);
    slime.setMood('idle');
    slime.step(6);   // its first blink and glance are over
    while (slime.needsFrames()) slime.step(1 / 30);   // let whatever is moving finish
    assert.equal(slime.needsFrames(), false);
    const wake = slime.nextWakeMs();
    assert.ok(wake >= 1 && wake < 25000, `it wakes in ${wake} ms`);
});

test('the moods with something always moving ask for frames, the calm one does not', () => {
    for (const mood of MOODS) {
        const slime = new Slime(9);
        slime.setMood(mood);
        slime.step(8);
        while (mood === 'idle' && slime.needsFrames()) slime.step(1 / 30);
        const moving = ['happy', 'listening', 'thinking', 'speaking', 'alert', 'searching', 'curious', 'sleepy', 'sad', 'love'].includes(mood);
        if (moving) assert.equal(slime.needsFrames(), true, mood);
    }
});

test('every idle act can be started, runs its length and ends', () => {
    for (const act of ACTS) {
        const slime = new Slime(6);
        slime.setMood('idle');
        slime.step(1);
        const length = slime.startAct(act);
        assert.ok(length > 0.5, act);
        assert.equal(slime.act, act);
        slime.step(length + 0.2);
        assert.equal(slime.act, null, `${act} ended`);
    }
});

test('an act starts only while it is calm', () => {
    const slime = new Slime(6);
    slime.setMood('happy');
    assert.equal(slime.startAct('yawn'), 0);
    assert.equal(slime.startAct('nonsense'), 0);
});

test('left alone, a calm slime dozes off, and a poke wakes it', () => {
    const slime = new Slime(8);
    slime.setMood('idle');
    slime.step(DOZE_AFTER + 2);
    assert.equal(slime.mood, 'sleepy');
    slime.poke();
    assert.equal(slime.mood, 'idle');
});

test('an alert shivers and stretches; a sad one droops lower', () => {
    const alert = new Slime(1); alert.setMood('alert'); alert.step(2);
    const sad = new Slime(1); sad.setMood('sad'); sad.step(2);
    const calm = new Slime(1); calm.setMood('idle'); calm.step(2);
    assert.ok(alert.frame().ry > calm.frame().ry, 'alert is taller');
    assert.ok(sad.frame().ry < calm.frame().ry, 'sad is lower');
    assert.ok(sad.frame().rx > calm.frame().rx, 'and wider');
});
