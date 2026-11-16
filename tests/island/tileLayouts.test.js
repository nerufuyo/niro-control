// The tiling layouts: every window gets room inside the area, windows do not overlap (but in Monocle), gaps are kept.
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {arrange, LAYOUT_IDS, LAYOUTS} from '../../shell/tile/layouts.js';

const AREA = {x: 0, y: 32, width: 2560, height: 1048};
const OPT = {gapInner: 10, gapOuter: 12, masterFactor: 0.55, columnWidth: 0.5, focus: 0};
const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('there are ten layouts, each named once', () => {
    assert.equal(LAYOUTS.length, 10);
    assert.equal(new Set(LAYOUT_IDS).size, 10);
});

for (const layout of LAYOUT_IDS) {
    test(`${layout}: one rectangle per window, inside the area, none empty`, () => {
        for (let n = 1; n <= 12; n++) {
            const rects = arrange(layout, n, AREA, OPT);
            assert.equal(rects.length, n, `${layout} ${n}`);
            for (const r of rects) {
                assert.ok(r.width > 0 && r.height > 0, `${layout} ${n} empty`);
                assert.ok(r.x >= AREA.x + OPT.gapOuter - 1 && r.y >= AREA.y + OPT.gapOuter - 1, `${layout} ${n} outside (start)`);
                assert.ok(r.x + r.width <= AREA.x + AREA.width - OPT.gapOuter + 1 && r.y + r.height <= AREA.y + AREA.height - OPT.gapOuter + 1, `${layout} ${n} outside (end)`);
            }
        }
    });
    if (layout !== 'monocle') test(`${layout}: windows in view do not overlap`, () => {
        for (let n = 1; n <= 12; n++) {
            const rects = arrange(layout, n, AREA, OPT).filter(r => !r.hidden);
            for (let i = 0; i < rects.length; i++)
                for (let j = i + 1; j < rects.length; j++)
                    assert.ok(!hit(rects[i], rects[j]), `${layout} ${n}: ${i} and ${j} overlap`);
        }
    });
}

test('a single window fills the area less the outer gap', () => {
    for (const layout of LAYOUT_IDS.filter(l => l !== 'scrolling')) assert.deepEqual(arrange(layout, 1, AREA, OPT)[0], {x: 12, y: 44, width: 2536, height: 1024}, layout);
});

test('scrolling: a single window is one column wide', () => {
    const [r] = arrange('scrolling', 1, AREA, OPT);
    assert.ok(r.width < AREA.width / 2 + 1 && r.height === 1024);
});

test('the master gets its share on the side the layout names', () => {
    const left = arrange('master-left', 3, AREA, OPT);
    const right = arrange('master-right', 3, AREA, OPT);
    assert.ok(left[0].x < left[1].x && right[0].x > right[1].x);
    assert.ok(Math.abs(left[0].width / (left[0].width + left[1].width) - 0.55) < 0.01);
    const centre = arrange('center-master', 3, AREA, OPT);
    assert.ok(centre[1].x > centre[0].x && centre[2].x < centre[0].x, 'the others sit on both sides of the centre');
});

test('the gap between tiles is the inner gap', () => {
    const [a, b] = arrange('horizontal', 2, AREA, OPT);
    assert.equal(b.x - (a.x + a.width), 10);
    const [c, d] = arrange('vertical', 2, AREA, OPT);
    assert.equal(d.y - (c.y + c.height), 10);
});

test('grid: 5 windows are two rows, the shorter row wider', () => {
    const r = arrange('grid', 5, AREA, OPT);
    assert.equal(r.filter(x => x.y === r[0].y).length, 3);
    assert.ok(r[3].width > r[0].width);
});

test('scrolling keeps the focused column in view and hides the ones that do not fit', () => {
    const r = arrange('scrolling', 6, AREA, {...OPT, focus: 5});
    assert.ok(!r[5].hidden && !r[4].hidden);
    assert.ok(r[0].hidden && r[1].hidden);
    const first = arrange('scrolling', 6, AREA, {...OPT, focus: 0});
    assert.ok(!first[0].hidden && first[5].hidden);
});

test('monocle: all the same rectangle', () => {
    const r = arrange('monocle', 4, AREA, OPT);
    for (const x of r) assert.deepEqual(x, r[0]);
});

test('a nonsense count gives nothing, an unknown layout is Dwindle', () => {
    assert.deepEqual(arrange('grid', 0, AREA, OPT), []);
    assert.deepEqual(arrange('nope', 3, AREA, OPT), arrange('dwindle', 3, AREA, OPT));
});
