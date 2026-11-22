// Search keeps clear of the Niro Island: when it moves, how far, and where it stops. Pure logic; runtime geometry is in tests/shell/search-collision.sh.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {obstacle, placeSearch, SAFE_GAP} from '../../shell/search/build/placement.js';
import {SearchMotion} from '../../shell/search/build/searchMotion.js';

const mon = (w = 1920, h = 1080) => ({x: 0, y: 0, width: w, height: h});
const base = (w = 1920, h = 1080, over = {}) => {
    const m = mon(w, h);
    return {work: {x: 0, y: 32, width: w, height: h - 32}, panelX: Math.round((w - 680) / 2), panelWidth: 680, defaultY: Math.round(h * 0.16),
        fixedHeight: 120, wantedResults: 300, island: null, ...over};
};
const island = (w = 1920, over = {}) => ({x: (w - 600) / 2, y: 8, width: 600, height: 198, ...over});

test('no island: Search stays at its anchor with the full results height', () => {
    const r = placeSearch(base());
    assert.deepEqual(r, {offset: 0, maxResults: 300, collides: false});
});

test('compact island does not touch Search: no move', () => {
    const r = placeSearch(base(1920, 1080, {island: island(1920, {height: 44})}));
    assert.equal(r.offset, 0); assert.equal(r.collides, false);
});

test('expanded island overlapping Search: top lands exactly bottom + gap below', () => {
    const b = base(1920, 1080, {island: island()});     // island bottom 206, default y 173
    const r = placeSearch(b);
    assert.equal(r.collides, true);
    assert.equal(b.defaultY + r.offset, 206 + SAFE_GAP);
    assert.equal(SAFE_GAP, 12);
    assert.equal(r.maxResults, 300);
});

test('the gap is configurable', () => {
    const r = placeSearch(base(1920, 1080, {island: island(), gap: 30}));
    assert.equal(173 + r.offset, 236);
});

test('closer than the gap counts as in the way, farther does not', () => {
    const near = placeSearch(base(1920, 1080, {island: island(1920, {y: 0, height: 165})}));   // bottom 165, Search top 173: 8 px < 12
    assert.equal(near.collides, true); assert.equal(173 + near.offset, 177);
    const far = placeSearch(base(1920, 1080, {island: island(1920, {y: 0, height: 161})}));    // bottom 161 + 12 = 173: exactly the gap
    assert.equal(far.collides, false); assert.equal(far.offset, 0);
});

test('restoration: the island going away gives offset 0 again', () => {
    const b = base(1920, 1080, {island: island()});
    assert.ok(placeSearch(b).offset > 0);
    assert.equal(placeSearch({...b, island: null}).offset, 0);
    assert.equal(placeSearch({...b, island: island(1920, {height: 44})}).offset, 0);
});

test('an island that is already lower than the anchor never pulls Search up', () => {
    const r = placeSearch(base(1920, 1080, {island: island(1920, {y: 300, height: 200})}));      // spans Search's rows but starts below its top
    assert.ok(r.offset >= 0);
    assert.equal(173 + r.offset, 512);
});

test('horizontal non-overlap: no move', () => {
    const b = base(1920, 1080);
    assert.equal(placeSearch({...b, island: {x: 0, y: 8, width: 300, height: 198}}).collides, false);              // left of Search
    assert.equal(placeSearch({...b, island: {x: 1700, y: 8, width: 200, height: 198}}).collides, false);           // right of it
    assert.equal(placeSearch({...b, island: {x: b.panelX + 680, y: 8, width: 100, height: 198}}).collides, false); // touching edges only
    assert.equal(placeSearch({...b, island: {x: b.panelX + 679, y: 8, width: 100, height: 198}}).collides, true);   // 1 px in
});

test('big results: the list shrinks to the room left, the entry keeps the island-clear position', () => {
    const b = base(1920, 1080, {island: island(), wantedResults: 800});      // more than fits below the island
    const r = placeSearch(b);
    const y = 173 + r.offset;
    assert.equal(y, 218);
    assert.ok(y + 120 + r.maxResults <= 1080);
    assert.equal(r.maxResults, 1080 - 218 - 120);
});

test('small monitor (1280x720) with a tall list: never past the bottom, entry visible', () => {
    const b = base(1280, 720, {island: island(1280), wantedResults: 360, fixedHeight: 200});   // default y 115, island bottom 206
    const r = placeSearch(b);
    const y = 115 + r.offset;
    assert.equal(y, 218);
    assert.ok(y + b.fixedHeight + r.maxResults <= 720);
    assert.ok(r.maxResults > 0 && r.maxResults < 360);
});

test('not even the bare entry fits below the island: entry stays visible, list is empty, panel pushed up only as far as needed', () => {
    const b = base(1280, 300, {island: island(1280), wantedResults: 100, fixedHeight: 120});
    const r = placeSearch(b);
    const y = b.defaultY + r.offset;
    assert.equal(r.maxResults, 0);
    assert.ok(y + 120 <= 300);
    assert.ok(y >= b.work.y);
});

test('scale 2: logical pixels in, logical pixels out (a 1920x1080 panel at scale 2 is 960x540 logical)', () => {
    const b = base(960, 540, {island: {x: 180, y: 4, width: 300, height: 99}, fixedHeight: 60, wantedResults: 150});
    const r = placeSearch({...b, panelWidth: 340, panelX: 310});
    assert.equal(r.collides, true);
    assert.equal(b.defaultY + r.offset, 103 + SAFE_GAP);
    assert.ok(b.defaultY + r.offset + 60 + r.maxResults <= 540);
});

test('obstacle: hidden, empty, missing or on another monitor is no obstacle', () => {
    const m = mon();
    assert.equal(obstacle(null, true, m), null);
    assert.equal(obstacle(island(), false, m), null);
    assert.equal(obstacle(island(1920, {height: 0}), true, m), null);
    assert.equal(obstacle(island(), true, m) !== null, true);
    assert.equal(obstacle(island(), true, {x: 1920, y: 0, width: 1920, height: 1080}), null);    // Search on the second monitor
    const second = {x: 1920 + 660, y: 8, width: 600, height: 198};
    assert.equal(obstacle(second, true, m), null);
    assert.ok(obstacle(second, true, {x: 1920, y: 0, width: 1920, height: 1080}));
});

test('the offset: follows the island on the way down, springs back on the way up, no overshoot, velocity kept, reduced motion and off jump', () => {
    let reduced = false, off = false;
    const sm = new SearchMotion({reduced: () => reduced, off: () => off});
    sm.place(20); assert.equal(sm.dodge.value, 20);           // the island is ahead: the panel stays clear of it, frame by frame
    sm.place(33); assert.equal(sm.dodge.value, 33);
    sm.place(0);                                              // island collapsed: the spring takes over
    assert.equal(sm.dodge.value, 33); assert.equal(sm.dodge.target, 0);
    let t = 0, last = 33;
    for (let i = 0; i < 6; i++) { sm.tick(t += 16.67); assert.ok(sm.dodge.value <= last && sm.dodge.value >= 0); last = sm.dodge.value; }
    assert.ok(sm.dodge.value > 0 && sm.dodge.value < 33);
    const v = sm.dodge.velocity;
    assert.ok(v < 0);
    sm.place(10);                                             // island came back half way: retarget, keep the speed
    assert.equal(sm.dodge.velocity, v); assert.equal(sm.dodge.target, 10);
    let low = Infinity;
    for (let i = 0; i < 400; i++) { sm.tick(t += 16.67); low = Math.min(low, sm.dodge.value); }
    assert.ok(Math.abs(sm.dodge.value - 10) < 1e-6 && low >= 10 - 4, 'settles on 10; carrying its speed it may dip a few px under it: ' + low);
    sm.place(0);
    for (let i = 0; i < 400; i++) { sm.tick(t += 16.67); low = Math.min(low, sm.dodge.value); }
    assert.equal(sm.dodge.value, 0); assert.ok(low >= -1e-6, 'never below the anchor ' + low);
    reduced = true; sm.place(33); assert.equal(sm.dodge.value, 33); sm.place(0); assert.equal(sm.dodge.value, 0);
    reduced = false; off = true; sm.place(12); sm.place(5); assert.equal(sm.dodge.value, 5);
    sm.place(12, true); assert.equal(sm.dodge.value, 12);
});
