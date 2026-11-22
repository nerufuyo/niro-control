// Search overlay motion: the state machine, the springs that open and close it, and the rules that keep late results
// from moving the selection. Pure, so node runs it; the Clutter side only draws what these say.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createSearchMachine, isLive, isShown, keepScrollValue, panelPose, planUpdate, resultKey, rowReveal, SearchMotion} from '../../shell/search/build/searchMotion.js';

const states = m => { const seen = []; m.onChange((n, p, e) => seen.push(`${p}>${n}:${e}`)); return seen; };

test('machine: open, settle, results, execute, dismiss, close', () => {
    const m = createSearchMachine();
    const seen = states(m);
    assert.equal(m.state, 'Closed');
    m.send('open'); assert.equal(m.state, 'Opening');
    m.send('settled', {count: 0}); assert.equal(m.state, 'Ready');
    m.send('results', {count: 3}); assert.equal(m.state, 'ResultsExpanded');
    m.send('results', {count: 0}); assert.equal(m.state, 'Ready');
    m.send('results', {count: 2});
    m.send('execute'); assert.equal(m.state, 'Executing');
    m.send('close'); assert.equal(m.state, 'Dismissing');
    m.send('settled'); assert.equal(m.state, 'Closed');
    assert.equal(seen.length, 8);
});

test('machine: results that arrive while opening are not lost, and opening finishes into the right state', () => {
    const m = createSearchMachine();
    m.send('open');
    m.send('results', {count: 4});
    assert.equal(m.state, 'ResultsExpanded');
    const n = createSearchMachine();
    n.send('open'); n.send('results', {count: 0}); assert.equal(n.state, 'Opening');
    n.send('settled', {count: 5}); assert.equal(n.state, 'ResultsExpanded');
});

test('machine: Esc and Enter have a way out of every state, and a stray event never wedges it', () => {
    for (const path of [['open'], ['open', 'settled'], ['open', 'settled', 'results'], ['open', 'execute']]) {
        const m = createSearchMachine();
        for (const e of path) m.send(e, {count: 1});
        assert.ok(['Opening', 'Ready', 'ResultsExpanded', 'Executing'].includes(m.state));
        m.send('close'); assert.equal(m.state, 'Dismissing', path.join());
        m.send('settled'); assert.equal(m.state, 'Closed');
    }
    const m = createSearchMachine();
    for (const e of ['settled', 'close', 'dismiss', 'execute', 'results', 'nonsense']) m.send(e, {count: 1});
    assert.equal(m.state, 'Closed');                       // nothing opens it but `open`
    m.send('open'); assert.equal(m.state, 'Opening');
});

test('machine: rapid open/close/open is safe from Dismissing and Executing', () => {
    const m = createSearchMachine();
    m.send('open'); m.send('close'); assert.equal(m.state, 'Dismissing');
    m.send('open'); assert.equal(m.state, 'Opening');       // reopened mid-fade
    m.send('settled', {count: 0}); m.send('execute'); m.send('open'); assert.equal(m.state, 'Opening');
    for (let i = 0; i < 50; i++) { m.send('close'); m.send('open'); }
    assert.equal(m.state, 'Opening');
    assert.ok(isLive(m.state) && isShown(m.state));
    assert.ok(!isLive('Dismissing') && isShown('Dismissing') && !isShown('Closed'));
});

/** A frame clock for a SearchMotion: calls tick until it stops asking. */
function rig(opts = {}) {
    const log = {wakes: 0, opened: 0, closed: 0, frames: 0};
    const m = new SearchMotion({onWake: () => log.wakes++, onFrame: () => log.frames++, onOpened: () => log.opened++, onClosed: () => log.closed++, ...opts});
    let t = 0;
    const run = (ms = 2000, hz = 60) => { const n = Math.round(ms / (1000 / hz)); for (let i = 0; i < n; i++) { t += 1000 / hz; if (!m.tick(t)) return i + 1; } return n; };
    return {m, log, run};
}

test('opening never overshoots, reaches full, reports opened once, and stops asking for frames', () => {
    const {m, log, run} = rig();
    m.open();
    assert.equal(log.wakes, 1);
    let peak = 0, t = 0;
    while (m.tick(t += 1000 / 120)) { peak = Math.max(peak, m.panel.value); if (t > 3000) assert.fail('never settled'); }
    assert.ok(peak <= 1, `overshoot ${peak}`);
    assert.equal(m.panel.value, 1);
    assert.equal(log.opened, 1);
    assert.equal(m.animator.active, false);
    assert.equal(run(100), 1);                              // idle: one dead tick, no work
});

test('closing reports closed only after the fade, and reopening mid-fade reverses without a jump', () => {
    const {m, log, run} = rig();
    m.open(); run();
    m.close();
    let t = 10000;
    for (let i = 0; i < 6; i++) m.tick(t += 16);
    const mid = m.panel.value;
    assert.ok(mid > 0 && mid < 1 && log.closed === 0);
    m.open();                                               // interrupted
    m.tick(t += 16);
    assert.ok(Math.abs(m.panel.value - mid) < 0.15, 'position continues smoothly');
    run();
    assert.equal(m.panel.value, 1);
    assert.equal(log.closed, 0);
    m.close(); run();
    assert.equal(log.closed, 1);
    assert.equal(m.panel.value, 0);
});

test('animations off: open and close jump, no frame loop is ever requested', () => {
    const {m, log} = rig({off: () => true});
    m.open();
    assert.equal(m.panel.value, 1); assert.equal(log.wakes, 0); assert.equal(log.opened, 1);
    m.revealList(); assert.equal(m.reveal.value, 1);
    m.select(null, 'a'); assert.equal(log.wakes, 0);
    m.close();
    assert.equal(m.panel.value, 0); assert.equal(log.closed, 1); assert.equal(log.wakes, 0);
});

test('reduced motion: still no overshoot', () => {
    const {m, run} = rig({reduced: () => true});
    m.open();
    let peak = 0, t = 0;
    while (m.tick(t += 8)) { peak = Math.max(peak, m.panel.value); if (t > 3000) break; }
    assert.ok(peak <= 1);
    run();
});

test('selection highlight crosses over: the old row fades while the new one grows, then the old is forgotten', () => {
    const {m, run} = rig();
    m.select(null, 'a', true);
    assert.equal(m.alpha('a'), 1);
    m.select('a', 'b');
    let t = 0;
    m.tick(t += 16); m.tick(t += 16);
    assert.ok(m.alpha('a') < 1 && m.alpha('b') > 0);
    run();
    assert.equal(m.alpha('b'), 1);
    assert.ok(!m.highlight.has('a'));
    m.dropHighlights(); assert.equal(m.highlight.size, 0);
});

test('cancel stops frames at once (disable)', () => {
    const {m} = rig();
    m.open(); m.cancel();
    assert.equal(m.animator.active, false);
    assert.equal(m.tick(100), false);
});

test('pose: appears near its anchor and is bounded', () => {
    assert.deepEqual(panelPose(1), {opacity: 255, scale: 1, dy: -0});
    const p0 = panelPose(0);
    assert.equal(p0.opacity, 0); assert.ok(p0.scale < 1 && p0.dy < 0 && p0.dy > -20);
    assert.equal(panelPose(2).opacity, 255);                // never above full, so an overshoot upstream cannot flash
    assert.equal(panelPose(-1).opacity, 0);
});

test('row reveal: staggered, capped, and the rows beyond the cap are simply there', () => {
    assert.equal(rowReveal(0, 0).opacity, 0);
    assert.ok(rowReveal(0.3, 0).opacity > rowReveal(0.3, 3).opacity);
    for (let i = 0; i < 8; i++) assert.equal(rowReveal(1, i).opacity, 255);
    assert.deepEqual(rowReveal(0, 40), {opacity: 255, dy: 0});
    const late = [...Array(8).keys()].map(i => rowReveal(0.5, i).opacity);
    assert.deepEqual([...late].sort((a, b) => b - a), late);   // monotone down the list
});

const K = (...n) => n.map(x => `k${x}`);
test('a new query starts at the top and reveals every row', () => {
    const plan = planUpdate({keys: K(1, 2, 3), selected: 2}, K(7, 8), true);
    assert.equal(plan.selected, 0); assert.deepEqual(plan.animate, [true, true]); assert.equal(plan.keepScroll, false);
});

test('a late arrival keeps the selection on the same result, reveals only what is new, keeps the scroll', () => {
    const plan = planUpdate({keys: K(1, 2, 3), selected: 2}, K(9, 1, 2, 3), false);   // a file landed above the selection
    assert.equal(plan.selected, 3);
    assert.deepEqual(plan.animate, [true, false, false, false]);
    assert.equal(plan.keepScroll, true);
});

test('a late update that drops the selected result clamps instead of jumping to the top', () => {
    assert.equal(planUpdate({keys: K(1, 2, 3), selected: 2}, K(1, 2), false).selected, 1);
    assert.equal(planUpdate({keys: K(1, 2, 3), selected: 1}, [], false).selected, -1);
    assert.equal(planUpdate({keys: [], selected: 0}, K(1), false).selected, 0);
});

test('result identity ignores position; the same action with other arguments is another result', () => {
    const a = {section: 'Files', action: 'file.open', args: {path: '/a'}, title: 'a'};
    assert.equal(resultKey(a), resultKey({...a}));
    assert.notEqual(resultKey(a), resultKey({...a, args: {path: '/b'}}));
});

test('scroll is restored but never past the end', () => {
    assert.equal(keepScrollValue(120, 500, 200), 120);
    assert.equal(keepScrollValue(400, 500, 200), 300);
    assert.equal(keepScrollValue(-5, 100, 200), 0);
});
