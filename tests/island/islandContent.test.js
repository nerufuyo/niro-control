// Content that follows the island's surface (surfaceMotion.ts: edgeShifts, travelProgress, arrivalGate, roomGate): where the content at the
// edges sits while the surface widens and narrows, and when content arriving with it is revealed. Pure, driven by the real spring on a fake
// frame clock, so what is checked is the path the island's width takes. What it does on screen is checked in a real shell by
// tests/shell/island-steps-clip.sh (every painted frame's actor boxes).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Spring} from '../../shell/shared/motionEngine.js';
import {SURFACE_SPRING, arrivalGate, edgeShifts, roomGate, travelProgress} from '../../shell/island/build/src/surfaceMotion.js';

const REST = {restDistance: 0.25, restSpeed: 2};
/** The surface's width every frame while it springs from `from` to `to`, as the island's own spring does. */
const path = (from, to, hz = 60) => {
    const s = new Spring(from, SURFACE_SPRING, REST);
    s.setTarget(to);
    const out = [from];
    for (let i = 0; i < hz && !s.settled; i++) {
        s.step(1 / hz);
        out.push(s.value);
    }
    return out;
};
const centred = (width, monitor = 1920) => ({left: (monitor - width) / 2, right: (monitor + width) / 2});

test('edge shifts: zero at rest, and the content pinned to an edge keeps its place from it (signed)', () => {
    const rest = centred(190);
    assert.deepEqual(edgeShifts(rest, rest, true), {left: 0, right: 0});
    assert.deepEqual(edgeShifts(rest, rest, false), {left: 0, right: 0});
    // Widening from 152 to 190: the content, laid out at 190, would sit 19 px past each edge of the 152 surface at once; the shift brings it back.
    const surface = centred(152);
    const shifts = edgeShifts(surface, rest, true);
    assert.deepEqual(shifts, {left: 19, right: -19});
    // the left sign is at the surface's edge plus its inset, whatever the width
    const inset = 4;
    assert.equal(rest.left + inset + shifts.left, surface.left + inset);
});

test('signed (the same view in a new size) follows both ways; unsigned (a view coming in) only from past the edge', () => {
    const rest = centred(152);
    const wider = centred(190);   // narrowing 190 -> 152: the surface is still wider than the view
    assert.deepEqual(edgeShifts(wider, rest, true), {left: -19, right: 19}, 'a sign moves in with the edge');
    assert.deepEqual(edgeShifts(wider, rest, false), {left: 0, right: 0}, 'a view fading in on a wider surface stays where it rests');
    const narrower = centred(100);
    assert.deepEqual(edgeShifts(narrower, rest, false), {left: 26, right: -26}, 'on a narrower one it is not left past the edge');
});

test('along the real spring path no frame moves the content by more than the edge moved (no teleport), at 30, 60 and 144 Hz', () => {
    for (const hz of [30, 60, 144]) {
        for (const [from, to] of [[152, 190], [190, 152], [152, 720], [720, 152], [100, 152]]) {
            const rest = centred(to);
            let previous = null, left = null;
            for (const w of path(from, to, hz)) {
                const surface = centred(w);
                const shift = edgeShifts(surface, rest, true);
                const place = rest.left + 4 + shift.left;      // where the left sign is on screen
                if (previous !== null) {
                    const edge = Math.abs(surface.left - left);
                    assert.ok(Math.abs(place - previous) <= edge + 1e-9, `${from}->${to} @${hz}: sign ${place - previous} vs edge ${edge}`);
                }
                previous = place;
                left = surface.left;
            }
            assert.ok(Math.abs(previous - (rest.left + 4)) < 1, 'ends at its resting place');
        }
    }
});

test('the sign stays inside the surface throughout, widening or narrowing', () => {
    for (const [from, to] of [[152, 190], [190, 152], [152, 720], [720, 152]]) {
        const rest = centred(to);
        for (const w of path(from, to)) {
            const surface = centred(w);
            const shift = edgeShifts(surface, rest, true);
            assert.ok(rest.left + 4 + shift.left >= surface.left - 1e-9, 'not past the left edge');
            assert.ok(rest.right - 4 + shift.right <= surface.right + 1e-9, 'not past the right edge');
        }
    }
});

test('travel progress: 0 to 1 along the way, 1 when there is none, either direction', () => {
    assert.equal(travelProgress(152, 152, 190), 0);
    assert.equal(travelProgress(171, 152, 190), 0.5);
    assert.equal(travelProgress(300, 152, 190), 1, 'clamped (overshoot)');
    assert.equal(travelProgress(190, 190, 190.5), 1, 'no travel');
    assert.equal(travelProgress(171, 190, 152), 0.5);
});

test('arrival gate: nothing until the surface is half way, all from 95 %, by width and never by time, turned round by the surface', () => {
    const [from, to] = [152, 190];
    assert.equal(arrivalGate(from, from, to), 0);
    assert.equal(arrivalGate(from + 0.5 * (to - from), from, to), 0);
    assert.equal(arrivalGate(from + 0.95 * (to - from), from, to), 1);
    assert.equal(arrivalGate(to + 6, from, to), 1, 'overshoot');
    assert.equal(arrivalGate(to, to, to), 1, 'content that arrives on a surface that does not grow shows at once');
    assert.equal(arrivalGate(to, to, from), 1, 'or on one that shrinks');
    let last = 0;
    for (const w of path(from, to)) {
        const g = arrivalGate(w, from, to);
        assert.ok(g >= 0 && g <= 1);
        if (w <= to)
            assert.ok(g >= last - 1e-9, 'rises with the width');
        last = Math.max(last, g);
    }
    assert.equal(last, 1);
    // a collapse half way (the width falls back): the gate falls with it, the same function of width, with no jump
    const g = w => arrivalGate(w, from, to);
    assert.ok(g(178) > g(170) && g(170) >= g(160));
    for (let w = 150; w < 192; w += 0.25)
        assert.ok(Math.abs(g(w + 0.25) - g(w)) < 0.12, 'no jump in the gate');
});

test('room gate: content shows only when the surface holds it (the view less its padding), after a short ramp', () => {
    const full = 720, edge = 20, ramp = 6;
    assert.equal(roomGate(152, full, {edge, ramp}), 0);
    assert.equal(roomGate(600, full, {edge, ramp}), 0);
    assert.equal(roomGate(full - 2 * edge, full, {edge, ramp}), 1, 'holds it exactly');
    assert.equal(roomGate(full, full, {edge, ramp}), 1);
    assert.equal(roomGate(full - 2 * edge - ramp, full, {edge, ramp}), 0);
    const mid = roomGate(full - 2 * edge - ramp / 2, full, {edge, ramp});
    assert.ok(mid > 0 && mid < 1);
    assert.equal(roomGate(679, full, {edge, ramp: 0}), 0, 'no ramp: a step');
    assert.equal(roomGate(680, full, {edge, ramp: 0}), 1);
});

test('room gate along the real opening and closing: shown content is never wider than the surface, and it shows before the surface stops', () => {
    const full = 720, edge = 20, ramp = 6;
    const opening = path(152, full);
    let first = null;
    opening.forEach((w, i) => {
        if (roomGate(w, full, {edge, ramp}) > 0.25) {
            assert.ok(w >= full - 2 * edge - ramp, 'room made before it shows past a quarter');
            first ??= i;
        }
    });
    assert.notEqual(first, null);
    assert.ok(first < opening.length - 1, 'before the last frame');
    // closing: the gate is gone before the surface is narrower than the content by more than the ramp
    for (const w of path(full, 152)) {
        if (roomGate(w, full, {edge, ramp}) > 0.25)
            assert.ok(w >= full - 2 * edge - ramp);
    }
});

// The wiring: source checks, so a refactor cannot quietly leave the follow behind in unit tests only.
const src = f => readFileSync(new URL(`../../shell/island/src/${f}`, import.meta.url), 'utf8');

test('wiring: the island tells its views, every frame and at each move, where its edges are; compact and expanded follow them', () => {
    const island = src('island.ts');
    assert.match(island, /edgeShifts\(/);
    // from the frame (_sync) and straight after a move's retargets (before the first frame), not only from one
    assert.ok((island.match(/this\._followViews\(\)/g) ?? []).length >= 2);
    assert.match(src('compact.ts'), /followSurface\(state\)[\s\S]*arrivalGate\(/);
    assert.match(src('compact.ts'), /_left\.translation_x = state \? state\.left : 0/);
    assert.match(src('expanded.ts'), /followSurface\(state\)[\s\S]*roomGate\(/);
    assert.match(src('expanded.ts'), /_tabsBox\.translation_x = state\.left/);
});

test('wiring: the island actor keeps its name (Search finds it by it)', () => {
    assert.match(src('island.ts'), /name: 'islandIsland'/);
});
