import test from 'node:test';
import assert from 'node:assert/strict';
import {Spring, Animator, SPRINGS, gaussianScale, magnifyRow, staggerDelay, edgeHysteresis, Machine, springFor, dampingRatio, criticallyDamped, magneticPull} from '../../shell/shared/motionEngine.js';

const run = (s, hz, secs = 3) => { const dt = 1 / hz; let t = 0; while (t < secs && !s.step(dt)) t += dt; return t; };

test('a spring converges to its target and snaps exactly', () => {
    const s = new Spring(0, 'standard').setTarget(100);
    run(s, 60);
    assert.equal(s.value, 100); assert.equal(s.velocity, 0); assert.ok(s.settled);
});

test('path is frame-rate independent (60/120/144 Hz agree)', () => {
    const at = hz => { const s = new Spring(0, 'fluid').setTarget(100); for (let i = 0; i < hz * 0.2; i++) s.step(1 / hz); return s.value; };
    assert.ok(Math.abs(at(60) - at(120)) < 0.5); assert.ok(Math.abs(at(120) - at(144)) < 0.5);
});

test('retargeting keeps velocity (no jolt)', () => {
    const s = new Spring(0, 'standard').setTarget(100);
    for (let i = 0; i < 6; i++) s.step(1 / 60);
    const v = s.velocity, x = s.value;
    s.setTarget(0);
    assert.equal(s.velocity, v); assert.equal(s.value, x);
});

test('presets: snappy/standard/fluid overshoot slightly, critically damped does not', () => {
    for (const k of ['snappy', 'standard', 'fluid', 'gentle']) assert.ok(dampingRatio(SPRINGS[k]) < 1.1);
    const peak = spec => { const s = new Spring(0, spec).setTarget(100); let m = 0; for (let i = 0; i < 600; i++) { s.step(1 / 120); m = Math.max(m, s.value); } return m; };
    assert.ok(peak('fluid') > 100);
    assert.ok(peak(criticallyDamped('fluid')) <= 100.0001);
});

test('a huge frame gap is clamped, not simulated', () => {
    const s = new Spring(0, 'standard').setTarget(10);
    s.step(60);
    assert.ok(Number.isFinite(s.value));
});

test('Animator idles when settled and wakes on demand', () => {
    const s = new Spring(0, 'snappy').setTarget(5);
    let wakes = 0, settled = 0, frames = 0;
    const a = new Animator([s], {onWake: () => wakes++, onSettled: () => settled++, onFrame: () => frames++});
    a.wake(); a.wake();
    assert.equal(wakes, 1);
    let t = 0; while (a.tick(t)) t += 8;
    assert.equal(settled, 1); assert.equal(a.active, false);
    assert.equal(a.tick(t + 8), false);
    s.setTarget(0); a.wake(); assert.equal(wakes, 2);
});

test('gaussian magnification peaks at the pointer and decays', () => {
    assert.equal(gaussianScale(0, 0.7, 60), 1.7);
    assert.ok(gaussianScale(60, 0.7, 60) < gaussianScale(0, 0.7, 60));
    assert.ok(gaussianScale(300, 0.7, 60) < 1.001);
    assert.equal(gaussianScale(10, 0.7, 0), 1);
});

test('magnified neighbours never overlap and keep order', () => {
    const centers = [30, 90, 150, 210, 270], sizes = Array(5).fill(48);
    const row = magnifyRow(centers, sizes, 150, 0.8, 70);
    for (let i = 1; i < row.length; i++) {
        const left = centers[i - 1] + row[i - 1].offset + (sizes[i - 1] * row[i - 1].scale) / 2;
        const right = centers[i] + row[i].offset - (sizes[i] * row[i].scale) / 2;
        assert.ok(right >= left - 0.001, `icons ${i - 1},${i} overlap`);
    }
});

test('stagger is capped; hysteresis does not flicker; machine ignores stray events', () => {
    assert.equal(staggerDelay(0), 0); assert.equal(staggerDelay(100), 160);
    assert.equal(edgeHysteresis(false, 5, 2, 12), false);
    assert.equal(edgeHysteresis(false, 2, 2, 12), true);
    assert.equal(edgeHysteresis(true, 10, 2, 12), true);
    assert.equal(edgeHysteresis(true, 13, 2, 12), false);
    const m = new Machine({closed: {open: 'opening'}, opening: {done: 'ready', close: 'closed'}, ready: {close: 'closed'}}, 'closed');
    assert.equal(m.send('done'), 'closed'); assert.equal(m.send('open'), 'opening'); assert.equal(m.send('open'), 'opening');
    assert.equal(m.send('close'), 'closed');
});

test('springFor honours reduced motion and off; magnetic pull fades to zero', () => {
    assert.equal(springFor('dock', {off: true}), null);
    assert.ok(dampingRatio(springFor('dock', {reduced: true})) >= 0.999);
    assert.ok(dampingRatio(springFor('search')) >= 0.999);
    assert.deepEqual(magneticPull(100, 0, 50, 0.3), {x: 0, y: 0});
    assert.ok(magneticPull(10, 0, 50, 0.3).x > 0);
});
