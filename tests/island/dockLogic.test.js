// Pure dock logic (shell/dock/src/lib/dockLogic.ts, loaded by node's type stripping) plus the shared engine's maths the dock
// relies on: state machine, edge zone bounded to the monitor, hysteresis, magnification without overlap, reveal spring.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    nextDockState, DOCK_TABLE, isDockActive, edgeDistance, pointerOnMonitor, edgeThresholds, springTimeScale, riseAbove, pointerNearDock,
} from '../../shell/dock/src/lib/dockLogic.ts';
import {Spring, gaussianScale, magnifyRow, edgeHysteresis, springFor} from '../../shell/shared/motionEngine.js';

const walk = (start, events, ctx) => events.reduce((s, e) => nextDockState(s, e, ctx), start);

test('the dock walks hidden -> revealing -> visible -> magnifying -> visible -> dismissing -> hidden', () => {
    assert.equal(walk('hidden', ['reveal']), 'revealing');
    assert.equal(walk('hidden', ['reveal', 'settled']), 'visible');
    assert.equal(walk('hidden', ['reveal', 'settled', 'magnify']), 'magnifying');
    assert.equal(walk('hidden', ['reveal', 'settled', 'magnify', 'relax']), 'visible');
    assert.equal(walk('hidden', ['reveal', 'settled', 'dismiss']), 'dismissing');
    assert.equal(walk('hidden', ['reveal', 'settled', 'dismiss', 'settled']), 'hidden');
});

test('a dismissal can be cancelled: reveal while dismissing goes back to revealing', () => {
    assert.equal(walk('visible', ['dismiss', 'reveal']), 'revealing');
    assert.equal(walk('visible', ['dismiss', 'reveal', 'settled']), 'visible');
});

test('launching returns to magnifying only if the pointer is still over the icons', () => {
    assert.equal(walk('magnifying', ['launch', 'launched'], {magnifying: true}), 'magnifying');
    assert.equal(walk('magnifying', ['launch', 'launched'], {magnifying: false}), 'visible');
    assert.equal(walk('visible', ['launch', 'magnify']), 'launching');
});

test('stray events never wedge or skip a state', () => {
    assert.equal(nextDockState('hidden', 'dismiss'), 'hidden');
    assert.equal(nextDockState('hidden', 'settled'), 'hidden');
    assert.equal(nextDockState('dismissing', 'magnify'), 'dismissing');
    assert.equal(nextDockState('dismissing', 'launch'), 'dismissing');
    // Every state is reachable and has a way out.
    for (const [s, row] of Object.entries(DOCK_TABLE)) assert.ok(Object.keys(row).length > 0, s);
});

test('rapid event storms always end in a defined state and hidden is the only inactive one', () => {
    const events = ['reveal', 'dismiss', 'magnify', 'launch', 'settled', 'relax', 'launched'];
    let seed = 7;
    let s = 'hidden';
    for (let i = 0; i < 2000; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        s = nextDockState(s, events[seed % events.length], {magnifying: seed % 2 === 0});
        assert.ok(s in DOCK_TABLE);
    }
    assert.equal(isDockActive('hidden'), false);
    for (const k of ['revealing', 'visible', 'magnifying', 'launching', 'dismissing']) assert.ok(isDockActive(k));
});

test('edge zone is bounded to the monitor on both axes', () => {
    const m = {x: 1920, y: 0, width: 1920, height: 1080};
    assert.equal(pointerOnMonitor(m, 2000, 1070), true);
    assert.equal(pointerOnMonitor(m, 1900, 1070), false);   // left monitor
    assert.equal(pointerOnMonitor(m, 3840, 1070), false);   // past the right end
    assert.equal(pointerOnMonitor(m, 2000, 1080), false);   // below
    assert.equal(edgeDistance(m, 0, 2000, 1070), 10);
    assert.equal(edgeDistance(m, 1, 1930, 500), 10);
    assert.equal(edgeDistance(m, 2, 3830, 500), 10);
    assert.equal(edgeDistance(m, 3, 2500, 4), 4);
});

test('hysteresis: enter inside the threshold, leave only past the larger one; no flicker on the boundary', () => {
    const {enter, leave} = edgeThresholds(25);
    assert.ok(leave > enter);
    let on = false;
    on = edgeHysteresis(on, enter + 1, enter, leave); assert.equal(on, false);
    on = edgeHysteresis(on, enter, enter, leave); assert.equal(on, true);
    // Jitter between enter and leave keeps it on.
    for (const d of [enter + 1, enter - 1, enter + 3, leave - 1, enter + 2]) on = edgeHysteresis(on, d, enter, leave), assert.equal(on, true);
    on = edgeHysteresis(on, leave + 1, enter, leave); assert.equal(on, false);
    // And it does not come straight back on at the same distance.
    on = edgeHysteresis(on, leave - 1, enter, leave); assert.equal(on, false);
    assert.ok(edgeThresholds(0).enter >= 1);
});

test('magnification: Gaussian, symmetric, peaks under the pointer, consistent across icon sizes', () => {
    assert.equal(gaussianScale(0, 0.6, 60), 1.6);
    assert.ok(Math.abs(gaussianScale(50, 0.6, 60) - gaussianScale(-50, 0.6, 60)) < 1e-12);
    assert.ok(gaussianScale(300, 0.6, 60) < 1.001);
    for (const size of [32, 48, 96]) {
        const centers = Array.from({length: 9}, (_, i) => i * (size + 8) + size / 2);
        const sizes = centers.map(() => size);
        const sigma = (size + 8) * 1.2;
        const row = magnifyRow(centers, sizes, centers[4] + 3, 0.7, sigma);
        // No icon overlaps its neighbour at its scaled size.
        for (let i = 1; i < row.length; i++) {
            const left = centers[i - 1] + row[i - 1].offset + sizes[i - 1] * row[i - 1].scale / 2;
            const right = centers[i] + row[i].offset - sizes[i] * row[i].scale / 2;
            assert.ok(right >= left - 1e-6, `size ${size}: icons ${i - 1} and ${i} overlap by ${left - right}`);
        }
        assert.ok(row[4].scale > row[0].scale);
        assert.equal(Math.max(...row.map(r => r.scale)), row[4].scale);
    }
});

test('magnification follows the pointer continuously (no jumps between adjacent pointer positions)', () => {
    const centers = Array.from({length: 7}, (_, i) => i * 56 + 24), sizes = centers.map(() => 48);
    let prev = null;
    for (let x = 0; x < 400; x += 2) {
        const row = magnifyRow(centers, sizes, x, 0.6, 70);
        if (prev) for (let i = 0; i < row.length; i++) assert.ok(Math.abs(row[i].scale - prev[i].scale) < 0.06, `scale jump at x=${x}`);
        prev = row;
    }
});

test('baseline stays level: pivot at the icon bottom, the rise is zero at scale 1 and grows with scale', () => {
    // top at 8 px inside the dock, 48 tall, pivot at the bottom (fraction 1)
    assert.equal(riseAbove(8, 0, 48, 1, 1), -8);          // resting: below the bar's top, nothing pokes out
    assert.ok(riseAbove(8, 0, 48, 1, 1.5) > riseAbove(8, 0, 48, 1, 1.2));
    assert.equal(riseAbove(8, 0, 48, 1, 1.5), 16);        // 24 px of growth minus the 8 px padding
    assert.equal(riseAbove(0, -28, 48, 1, 1), 28);        // a bounce counts
});

test('reveal spring: settles on both targets, a cancelled dismissal keeps its velocity, calm spring never overshoots', () => {
    const slide = new Spring(0, springFor('dock'), {restDistance: 0.002, restSpeed: 0.02});
    slide.setTarget(1);
    for (let i = 0; i < 6; i++) slide.step(1 / 60);
    assert.ok(slide.value > 0 && slide.value < 1.2);
    const calm = springFor('dock', {reduced: true});
    const out = new Spring(1, calm, {restDistance: 0.002, restSpeed: 0.02}).setTarget(0);
    let min = 1;
    for (let i = 0; i < 300 && !out.step(1 / 60); i++) min = Math.min(min, out.value);
    assert.ok(min >= -1e-9, 'dismissal must not bounce');
    assert.equal(out.value, 0);
    // Cancel halfway: velocity is not reset, so the turn-around is continuous.
    const s = new Spring(1, calm).setTarget(0);
    for (let i = 0; i < 5; i++) s.step(1 / 60);
    const v = s.velocity;
    s.setTarget(1, springFor('dock'));
    assert.equal(s.velocity, v);
    for (let i = 0; i < 600 && !s.step(1 / 60); i++);
    assert.equal(s.value, 1);
});

test('animations off yields no spring (the dock jumps); the duration setting scales time without changing damping ratio', () => {
    assert.equal(springFor('dock', {off: true}), null);
    assert.equal(springTimeScale(200), 1);
    assert.equal(springTimeScale(100), 2);
    assert.equal(springTimeScale(0), 1);
    const f = 2, base = springFor('dock');
    const scaled = {stiffness: base.stiffness * f * f, damping: base.damping * f, mass: base.mass};
    const ratio = c => c.damping / (2 * Math.sqrt(c.stiffness * c.mass));
    assert.ok(Math.abs(ratio(base) - ratio(scaled)) < 1e-12);
});

test('actor picks are only worth it near the dock', () => {
    const b = {x: 400, y: 1000, width: 800, height: 80};
    assert.equal(pointerNearDock(b, 20, 800, 990), true);
    assert.equal(pointerNearDock(b, 20, 800, 500), false);
    assert.equal(pointerNearDock(b, 20, 100, 1040), false);
});
