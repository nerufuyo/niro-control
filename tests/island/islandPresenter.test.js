// The surface machine as the controller's source of truth (SurfacePresenter), reduced motion, the split's reveal and alerts by priority.
// Pure (surfaceMotion.ts) plus source checks that the controller, island, compact view, music page and peek really use them; what they
// do on screen is checked in a real shell by tests/shell/island-steps-*.sh.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Spring, dampingRatio} from '../../shell/shared/motionEngine.js';
import {
    AXIS_LAG_MS, REVEAL_RISE_PX, SPLIT_MIN_ACTIVITIES, SURFACE_SPRING, SurfacePresenter, alertMotion, morphPlan, motionModeFor,
    revealDelays, splitRevealDelay, wantedState,
} from '../../shell/island/build/src/surfaceMotion.js';

const REST = {restDistance: 0.25, restSpeed: 2};
const inputs = (o = {}) => ({voice: false, expanded: false, alert: false, activities: 0, ...o});

test('wantedState: voice > open island > an alert (still the compact surface) > split > compact', () => {
    assert.equal(wantedState(inputs()), 'compact');
    assert.equal(wantedState(inputs({activities: SPLIT_MIN_ACTIVITIES - 1})), 'compact');
    assert.equal(wantedState(inputs({activities: SPLIT_MIN_ACTIVITIES})), 'split');
    assert.equal(wantedState(inputs({activities: 3})), 'split');
    assert.equal(wantedState(inputs({activities: 2, alert: true})), 'compact');
    assert.equal(wantedState(inputs({activities: 2, expanded: true, alert: true})), 'expanded');
    assert.equal(wantedState(inputs({expanded: true, voice: true})), 'immersive');
});

test('the presenter derives the presentation the views know from the state; every change is one machine event', () => {
    const p = new SurfacePresenter();
    const heard = [];
    p.onChange((to, from, event) => heard.push(`${from}>${to}:${event}`));
    assert.equal(p.presentation, 'compact');
    const run = (o, state, presentation) => {
        const r = p.resolve(inputs(o));
        assert.equal(p.state, state);
        assert.equal(p.presentation, presentation);
        return r;
    };
    run({}, 'compact', 'compact');
    run({activities: 2}, 'split', 'compact');
    run({activities: 2, alert: true}, 'compact', 'peek');
    run({activities: 2}, 'split', 'compact');
    run({expanded: true, activities: 2}, 'expanded', 'expanded');
    run({expanded: true, alert: true}, 'expanded', 'expanded');       // an alert waits behind the open island
    run({voice: true, expanded: true}, 'immersive', 'voice');
    run({}, 'compact', 'compact');
    assert.deepEqual(heard, [
        'idle>compact:compact', 'compact>split:split', 'split>compact:compact', 'compact>split:split', 'split>expanded:expand',
        'expanded>immersive:immerse', 'immersive>compact:compact',
    ]);
    assert.equal(run({}, 'compact', 'compact').changed, false);       // idempotent: a repeated render is no transition
});

test('auto-hide is the surface leaving: dismissing, settled, and back from wherever it is', () => {
    const p = new SurfacePresenter();
    p.resolve(inputs({activities: 2}));
    assert.equal(p.state, 'split');
    p.autoHide(true);
    assert.equal(p.state, 'dismissing');
    // a render that still wants the compact surface does not undo the dismissal while it is hidden
    p.resolve(inputs({activities: 2}));
    assert.equal(p.state, 'dismissing');
    p.settled();
    assert.equal(p.state, 'idle');
    // an alert arrives: it comes back as the compact surface showing it
    p.resolve(inputs({alert: true, activities: 2}));
    assert.equal(p.state, 'idle');
    p.autoHide(false);
    assert.equal(p.state, 'compact');
    assert.equal(p.presentation, 'peek');
    // interrupted mid-dismissal: back to what is wanted at once
    p.resolve(inputs({activities: 2}));
    p.autoHide(true);
    assert.equal(p.state, 'dismissing');
    p.autoHide(false);
    assert.equal(p.state, 'split');
    // the open island is never drawn into dismissing
    p.resolve(inputs({expanded: true}));
    p.autoHide(true);
    assert.equal(p.state, 'expanded');
});

test('a hidden surface can be opened: the open island and the assistant take over from dismissing and idle', () => {
    const p = new SurfacePresenter();
    p.resolve(inputs());
    p.autoHide(true);
    p.resolve(inputs({expanded: true}));
    assert.equal(p.state, 'expanded');
    p.autoHide(false);
    p.resolve(inputs());
    p.autoHide(true);
    p.settled();
    assert.equal(p.state, 'idle');
    p.resolve(inputs({voice: true}));
    assert.equal(p.state, 'immersive');
});

test('motionModeFor: off for preset off or the system animations off, reduced only for the minimal preset, else full', () => {
    assert.equal(motionModeFor({preset: 'off'}), 'off');
    assert.equal(motionModeFor({preset: 'default', reduced: true}), 'off');
    assert.equal(motionModeFor({preset: 'minimal', reduced: true}), 'off');
    assert.equal(motionModeFor({preset: 'minimal'}), 'reduced');
    for (const preset of ['', 'default', 'smooth', 'dynamic', 'cinematic', undefined])
        assert.equal(motionModeFor({preset}), 'full');
    assert.equal(motionModeFor(), 'full');
});

test('the reduced path, as the minimal preset reaches it: critically damped, both axes together, nothing staggered', () => {
    const plan = morphPlan({width: 150, height: 28}, {width: 720, height: 202}, {reduced: true});
    assert.equal(plan.order, 'together');
    assert.equal(plan.widthDelay + plan.heightDelay, 0);
    assert.ok(Math.abs(dampingRatio(plan.size) - 1) < 1e-9 && Math.abs(dampingRatio(plan.radius) - 1) < 1e-9);
    // driven like the island drives it, it never passes its target
    const w = new Spring(150, plan.size, REST), h = new Spring(28, plan.size, REST);
    w.setTarget(720, plan.size);
    h.setTarget(202, plan.size);
    let peak = 0;
    for (let t = 0; t < 2; t += 1 / 60) {
        w.step(1 / 60);
        h.step(1 / 60);
        peak = Math.max(peak, w.value - 720, h.value - 202);
    }
    assert.ok(peak <= 0.3, `overshot by ${peak}`);
    assert.deepEqual(revealDelays(4, {reduced: true}), [0, 0, 0, 0]);
    assert.equal(splitRevealDelay({mode: 'reduced'}), 0);
    assert.equal(splitRevealDelay({mode: 'off'}), 0);
    const calm = alertMotion({priority: 'instant'}, {reduced: true});
    assert.equal(calm.reveal, false);
    assert.ok(Math.abs(dampingRatio(calm.spring) - 1) < 1e-9);
});

test('the full path overshoots a little and sequences: width leads growing, height leads shrinking; off is instant', () => {
    const up = morphPlan({width: 150, height: 28}, {width: 720, height: 202});
    assert.equal(up.order, 'width-first');
    assert.ok(up.heightDelay === AXIS_LAG_MS && up.widthDelay === 0);
    const down = morphPlan({width: 720, height: 202}, {width: 150, height: 28});
    assert.equal(down.order, 'height-first');
    assert.ok(dampingRatio(up.size) < 1);
    assert.equal(morphPlan({width: 1, height: 1}, {width: 5, height: 5}, {off: true}).instant, true);
});

test('the split\'s second zone waits for the shape to make room, in full motion only', () => {
    assert.equal(splitRevealDelay({mode: 'full'}), AXIS_LAG_MS + revealDelays(2)[1]);
    assert.ok(splitRevealDelay({mode: 'full'}) > revealDelays(2)[1]);
    assert.ok(REVEAL_RISE_PX > 0 && REVEAL_RISE_PX <= 16);
});

test('an alert\'s spring by priority: critical snappy, routine and the volume critically damped; only a critical one reveals', () => {
    const critical = alertMotion({priority: 'instant'});
    const routine = alertMotion({priority: undefined});
    const volume = alertMotion({priority: 'instant', transient: true});
    assert.equal(critical.urgent, true);
    assert.equal(critical.reveal, true);
    assert.ok(dampingRatio(critical.spring) < 1 && critical.spring.stiffness > SURFACE_SPRING.stiffness);
    for (const calm of [routine, volume]) {
        assert.equal(calm.urgent, false);
        assert.equal(calm.reveal, false);
        assert.ok(Math.abs(dampingRatio(calm.spring) - 1) < 1e-9);
    }
});

// The wiring: source checks, so a refactor cannot quietly leave the animations behind in unit tests only.
const src = f => readFileSync(new URL(`../../shell/island/src/${f}`, import.meta.url), 'utf8');

test('the controller takes its presentation from the machine, never sets it apart, and morphs with the alert\'s spring', () => {
    const c = src('controller.ts');
    assert.match(c, /get _presentation\(\) \{\s*return this\._surface\.presentation;/);
    assert.doesNotMatch(c, /this\._presentation = /);
    assert.match(c, /this\._surface\.resolve\(\{voice: this\._voiceOpen, expanded: this\._expandWanted/);
    assert.match(c, /this\._surface\.autoHide\(hidden\)/);
    assert.match(c, /this\._surface\.settled\(\)/);
    assert.match(c, /this\._island\.morph\(size, view, \{spring: presentation === 'peek' \? this\._alertSpring\(\) : null\}\)/);
    assert.match(c, /'activities-changed'/);
    assert.match(c, /\.reveal\)\s*this\._peek\.reveal\(\)/);
});

test('the island names its springs on every move and reads the motion mode, so reduced motion is reachable', () => {
    const i = src('island.ts');
    assert.match(i, /motionMode\(\)/);
    assert.match(i, /reduced: mode === 'reduced'/);
    assert.match(i, /this\._width\.setTarget\(size\.width, sizeSpring\)/);
    assert.match(i, /this\._radius\.setTarget\(size\.radius, plan\.radius\)/);
    assert.match(src('motion.ts'), /motionModeFor\(\{preset, reduced/);
});

test('the content is revealed by the engine\'s stagger: the music page (and its reverse), the compact island, the peek', () => {
    const media = src('pages/media.ts');
    assert.match(media, /revealDelays\(pieces\.length/);
    assert.match(media, /_retreat\(\)/);
    assert.match(media, /delays\[pieces\.length - 1 - i\]/);          // the reverse order on the way out
    assert.match(media, /fromCurrent/);                                  // a retreat turned round keeps where each piece is
    const compact = src('compact.ts');
    assert.match(compact, /splitRevealDelay\(\{mode\}\)/);
    assert.match(compact, /activities-changed/);
    assert.match(compact, /_leave\(side\.child\)/);
    assert.match(src('peek.ts'), /revealDelays\(pieces\.length\)/);
});
