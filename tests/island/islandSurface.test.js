// The island as one surface: its state machine, the choreography of a move, reduced motion, and event coalescing.
// All pure (surfaceMotion.ts), plus the shared spring island/spring.ts now delegates to, driven by a fake frame clock.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Spring, dampingRatio} from '../../shell/shared/motionEngine.js';
import {
    AXIS_LAG_MS, Coalescer, MUSIC_REVEAL, RADIUS_SPRING, SURFACE_SPRING, SURFACE_STATES, alertMotion, axisOrder, createSurface,
    eventFor, morphPlan, revealDelays, surfaceStateFor,
} from '../../shell/island/build/src/surfaceMotion.js';

const REST = {restDistance: 0.25, restSpeed: 2};

const frames = (springs, hz, secs, onFrame = () => {}) => {
    const dt = 1 / hz;
    for (let t = 0; t < secs; t += dt) {
        springs.forEach(s => s.step(dt));
        onFrame(t);
    }
};

test('every state is reachable and the surface starts idle', () => {
    const m = createSurface();
    assert.equal(m.state, 'idle');
    const seen = new Set([m.state]);
    for (const event of ['compact', 'expand', 'immerse', 'split', 'dismiss', 'settled'])
        seen.add(m.send(event));
    assert.deepEqual([...seen].sort(), [...SURFACE_STATES].sort());
});

test('any live state can be interrupted into any other, including mid-dismissal', () => {
    for (const from of ['compact', 'expanded', 'immersive', 'split', 'dismissing']) {
        for (const to of ['compact', 'expanded', 'immersive', 'split']) {
            const m = createSurface(from);
            const next = m.send(eventFor(to));
            assert.equal(next, to, `${from} -> ${to}`);
        }
    }
});

test('dismissing lands on idle only once settled; a stray event cannot wedge it', () => {
    const m = createSurface('compact');
    m.send('dismiss');
    assert.equal(m.state, 'dismissing');
    assert.equal(m.send('nonsense'), 'dismissing');
    assert.equal(m.send('dismiss'), 'dismissing');
    assert.equal(m.send('settled'), 'idle');
    assert.equal(m.send('dismiss'), 'idle', 'nothing to dismiss when idle');
});

test('listeners hear each change once, with the previous state, and can detach', () => {
    const m = createSurface('compact');
    const heard = [];
    const off = m.onChange((next, prev, event) => heard.push([prev, next, event]));
    m.send('expand'); m.send('expand'); m.send('compact');
    off();
    m.send('immerse');
    assert.deepEqual(heard, [['compact', 'expanded', 'expand'], ['expanded', 'compact', 'compact']]);
});

test('the controller\'s presentations map to surface states', () => {
    assert.equal(surfaceStateFor('compact'), 'compact');
    assert.equal(surfaceStateFor('peek'), 'compact');
    assert.equal(surfaceStateFor('expanded'), 'expanded');
    assert.equal(surfaceStateFor('voice'), 'immersive');
    assert.equal(surfaceStateFor('expanded', {hidden: true}), 'idle');
});

test('growing in both axes widens first, shrinking in both lifts first, otherwise together', () => {
    assert.equal(axisOrder({width: 200, height: 30}, {width: 500, height: 200}), 'width-first');
    assert.equal(axisOrder({width: 500, height: 200}, {width: 200, height: 30}), 'height-first');
    assert.equal(axisOrder({width: 200, height: 200}, {width: 500, height: 30}), 'together');
    assert.equal(axisOrder({width: 200, height: 30}, {width: 200, height: 30}), 'together');
    assert.equal(axisOrder({width: 200, height: 30}, {width: 200.5, height: 30.5}), 'together', 'sub-pixel jitter is not an order');
});

test('the plan delays only the lagging axis, and none at all for reduced or off', () => {
    const grow = morphPlan({width: 200, height: 30}, {width: 500, height: 200});
    assert.equal(grow.order, 'width-first');
    assert.equal(grow.heightDelay, AXIS_LAG_MS);
    assert.equal(grow.widthDelay, 0);
    const shrink = morphPlan({width: 500, height: 200}, {width: 200, height: 30});
    assert.equal(shrink.widthDelay, AXIS_LAG_MS);
    assert.equal(shrink.heightDelay, 0);
    const reduced = morphPlan({width: 200, height: 30}, {width: 500, height: 200}, {reduced: true});
    assert.equal(reduced.heightDelay + reduced.widthDelay, 0);
    assert.ok(Math.abs(dampingRatio(reduced.size) - 1) < 1e-9, 'reduced is critically damped');
    assert.ok(Math.abs(dampingRatio(reduced.radius) - 1) < 1e-9);
    const off = morphPlan({width: 200, height: 30}, {width: 500, height: 200}, {off: true});
    assert.equal(off.instant, true);
    assert.equal(off.size, null);
});

test('the surface spring is elastic, radii never overshoot', () => {
    assert.ok(dampingRatio(SURFACE_SPRING) < 1);
    assert.ok(Math.abs(dampingRatio(RADIUS_SPRING) - 1) < 0.01);
    assert.equal(morphPlan({width: 1, height: 1}, {width: 2, height: 2}).size.damping, SURFACE_SPRING.damping);
});

test('retargeting mid-flight keeps velocity: position and speed are continuous at the switch', () => {
    const w = new Spring(200, SURFACE_SPRING, REST).setTarget(500);
    frames([w], 60, 0.12);
    const [x, v] = [w.value, w.velocity];
    assert.ok(v > 0);
    w.setTarget(200);
    assert.equal(w.value, x);
    assert.equal(w.velocity, v);
    w.step(1 / 240);
    assert.ok(Math.abs(w.value - x) < Math.abs(v) / 240 * 1.5 + 1, 'moves on at the speed it had, no jump');
    assert.ok(w.value > x, 'carries on the way it was going before turning back');
});

test('interrupting an expand with a collapse never drives the shape negative (top anchor holds)', () => {
    // The island hangs from y = 0, so its height spring is the bottom edge: it may undershoot its rest size but never
    // reach the top edge.
    const w = new Spring(200, SURFACE_SPRING, REST).setTarget(500);
    const h = new Spring(30, SURFACE_SPRING, REST).setTarget(200);
    let min = Infinity;
    frames([w, h], 120, 0.2, () => { min = Math.min(min, h.value, w.value); });
    w.setTarget(200); h.setTarget(30);
    frames([w, h], 120, 2, () => { min = Math.min(min, h.value, w.value); });
    assert.ok(min >= 0, `min ${min}`);
    assert.equal(h.value, 30);
    assert.equal(w.value, 200);
});

test('a sequenced expand (width then height) reaches its targets, with the same path at 60, 120 and 144 Hz', () => {
    const run = hz => {
        const w = new Spring(200, SURFACE_SPRING, REST).setTarget(500);
        const h = new Spring(30, SURFACE_SPRING, REST);
        let held = true;
        let t = 0;
        const dt = 1 / hz;
        const sample = [];
        while (t < 1.5) {
            if (held && t >= AXIS_LAG_MS / 1000) { held = false; h.setTarget(200); }
            w.step(dt); h.step(dt);
            t += dt;
            if (Math.abs(t - 0.3) < dt / 2) sample.push(w.value, h.value);
        }
        assert.equal(w.value, 500);
        assert.equal(h.value, 200);
        return sample;
    };
    const [a, b, c] = [run(60), run(120), run(144)];
    for (const other of [b, c]) {
        assert.ok(Math.abs(a[0] - other[0]) < 6, 'width');
        assert.ok(Math.abs(a[1] - other[1]) < 6, 'height');
    }
});

test('music start reveals in order with a capped stagger; reduced motion shows everything at once', () => {
    const d = revealDelays(MUSIC_REVEAL.length);
    assert.deepEqual(MUSIC_REVEAL.slice(0, 2), ['artwork', 'metadata']);
    for (let i = 1; i < d.length; i++)
        assert.ok(d[i] > d[i - 1]);
    assert.ok(revealDelays(50).every(x => x <= 160));
    assert.deepEqual(revealDelays(4, {reduced: true}), [0, 0, 0, 0]);
});

test('routine notifications are calm, critical ones are quick; a volume change never bounces', () => {
    const routine = alertMotion({key: 'n', priority: undefined});
    const critical = alertMotion({key: 'n', priority: 'instant'});
    const volume = alertMotion({key: 'osd', priority: 'instant', transient: true});
    assert.equal(routine.urgent, false);
    assert.ok(dampingRatio(routine.spring) >= 1 - 1e-9, 'no overshoot');
    assert.equal(critical.urgent, true);
    assert.ok(critical.spring.stiffness > routine.spring.stiffness);
    assert.equal(volume.urgent, false);
    assert.ok(dampingRatio(volume.spring) >= 1 - 1e-9, 'no surface bounce');
    assert.equal(alertMotion({priority: 'instant'}, {reduced: true}).reveal, false);
});

test('a burst of volume events: the first applies at once, the rest coalesce to one flush', () => {
    const c = new Coalescer(33);
    assert.deepEqual(c.offer(1000), {apply: true, wait: 0, schedule: false});
    const second = c.offer(1010);
    assert.equal(second.apply, false);
    assert.equal(second.schedule, true);
    assert.equal(second.wait, 23);
    const third = c.offer(1020);
    assert.equal(third.apply, false);
    assert.equal(third.schedule, false, 'one flush is already scheduled');
    c.flush(1033);
    assert.equal(c.offer(1040).apply, false, 'still inside the interval after a flush');
    assert.equal(c.offer(1100).apply, true);
});

test('a slow event is never held', () => {
    const c = new Coalescer(33);
    for (const t of [0, 100, 300, 900])
        assert.equal(c.offer(t).apply, true);
});

test('reset forgets the burst', () => {
    const c = new Coalescer(33);
    c.offer(0); c.offer(5);
    c.reset();
    assert.equal(c.offer(6).apply, true);
});

test('a spring goes idle: it settles in about a second and then reports rest at once', () => {
    const s = new Spring(0, SURFACE_SPRING, REST).setTarget(300);
    let n = 0;
    while (!s.step(1 / 60) && n < 600) n++;
    assert.ok(n < 100, `settles within ~1.5 s (took ${n} frames)`);
    assert.equal(s.value, 300);
    assert.equal(s.step(1 / 60), true);
});
