// SPDX-License-Identifier: GPL-3.0-or-later
// Where each window goes, for every layout. Pure: numbers in, rectangles out, so it is tested without a shell.
//
// `arrange(layout, count, area, options)` returns one rectangle `{x, y, width, height}` for each of `count` windows, in the
// order of the windows (the first is the master or the first tile). `area` is the work area of the monitor; the outer gap is
// taken from it here and the inner gap is kept between tiles.

export const LAYOUTS = [
    ['dwindle', 'Dwindle (BSP)', 'Splits the space in two again and again: the first window half, the next half of the rest'],
    ['master-left', 'Master left', 'A large window on the left, the others stacked on the right'],
    ['master-right', 'Master right', 'A large window on the right, the others stacked on the left'],
    ['center-master', 'Center master', 'The main window in the middle, the others on both sides'],
    ['grid', 'Grid', 'Equal cells in rows and columns'],
    ['three-columns', 'Three columns', 'Three equal columns; more windows stack in them'],
    ['horizontal', 'Horizontal split', 'Windows side by side, equal width'],
    ['vertical', 'Vertical split', 'Windows one above the other, equal height'],
    ['scrolling', 'Scrolling', 'Columns of a set width along a strip; the focused one stays in view'],
    ['monocle', 'Monocle', 'Every window fills the area; the focused one is on top'],
];
export const LAYOUT_IDS = LAYOUTS.map(l => l[0]);

const rect = (x, y, width, height) => ({x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height))});

/** `n` equal parts of `length` with `gap` between them: [offset, size] pairs. */
function parts(length, n, gap) {
    const size = (length - gap * (n - 1)) / n;
    return Array.from({length: n}, (_, i) => [i * (size + gap), size]);
}

/** `n` parts of `length` with `gap` between them, in proportion to `weights` (equal when there are none). */
function weighted(length, n, gap, weights) {
    const w = Array.from({length: n}, (_, i) => Math.max(0.05, weights?.length === n ? weights[i] : 1));
    const total = w.reduce((a, b) => a + b, 0);
    const room = length - gap * (n - 1);
    const out = [];
    let at = 0;
    w.forEach((x, i) => {
        const size = i === n - 1 ? length - at : (room * x) / total;
        out.push([at, size]);
        at += size + gap;
    });
    return out;
}

const column = (area, n, gap, weights) => weighted(area.height, n, gap, weights).map(([o, s]) => rect(area.x, area.y + o, area.width, s));
const row = (area, n, gap, weights) => weighted(area.width, n, gap, weights).map(([o, s]) => rect(area.x + o, area.y, s, area.height));

/** A rectangle's tiles in a stack: top to bottom (`vertical`), or left to right. */
const stack = (area, n, gap, vertical) => (vertical ? column(area, n, gap) : row(area, n, gap));

const clampRatio = r => Math.max(0.1, Math.min(0.9, r));

/** Each split of Dwindle: the space it divides, whether it divides it left/right (`wide`), and the share the first half takes. */
export function dwindleSplits(n, area, gap, ratios = []) {
    const out = [];
    let rest = area;
    for (let i = 0; i < n - 1; i++) {
        const wide = rest.width >= rest.height;   // a wide space splits into left and right, a tall one into top and bottom
        const share = clampRatio(ratios[i] ?? 0.5);
        out.push({rest, wide, share});
        if (wide) {
            const aw = Math.round((rest.width - gap) * share);
            rest = rect(rest.x + aw + gap, rest.y, rest.width - gap - aw, rest.height);
        } else {
            const ah = Math.round((rest.height - gap) * share);
            rest = rect(rest.x, rest.y + ah + gap, rest.width, rest.height - gap - ah);
        }
    }
    out.last = rest;
    return out;
}

function dwindle(n, area, gap, ratios) {
    const splits = dwindleSplits(n, area, gap, ratios);
    const out = splits.map(({rest, wide, share}) => (wide
        // the second half ends where the space ends: the rounding of the first never pushes it out
        ? rect(rest.x, rest.y, Math.round((rest.width - gap) * share), rest.height)
        : rect(rest.x, rest.y, rest.width, Math.round((rest.height - gap) * share))));
    out.push(rect(splits.last.x, splits.last.y, splits.last.width, splits.last.height));
    return out;
}

/** The master on one side (`left`, `right`, `top`, `bottom`), `factor` of the space; the rest stacked on the other. */
function master(side, n, area, gap, factor) {
    if (n === 1) return [rect(area.x, area.y, area.width, area.height)];
    const horizontal = side === 'left' || side === 'right';
    const total = horizontal ? area.width : area.height;
    const big = (total - gap) * factor;
    const small = total - gap - big;
    const first = side === 'left' || side === 'top';
    const [m, s] = horizontal
        ? [rect(area.x + (first ? 0 : small + gap), area.y, big, area.height), rect(area.x + (first ? big + gap : 0), area.y, small, area.height)]
        : [rect(area.x, area.y + (first ? 0 : small + gap), area.width, big), rect(area.x, area.y + (first ? big + gap : 0), area.width, small)];
    return [m, ...stack(s, n - 1, gap, horizontal)];
}

/** The master in the middle, the others alternately on the right and the left. With two windows it is a master on the left. */
function centerMaster(n, area, gap, factor) {
    if (n <= 2) return master('left', n, area, gap, factor);
    const mid = (area.width - 2 * gap) * factor;
    const side = (area.width - 2 * gap - mid) / 2;
    const rightIdx = [], leftIdx = [];
    for (let i = 1; i < n; i++) (i % 2 === 1 ? rightIdx : leftIdx).push(i);
    const out = new Array(n);
    out[0] = rect(area.x + side + gap, area.y, mid, area.height);
    const right = column(rect(area.x + side + gap + mid + gap, area.y, side, area.height), rightIdx.length, gap);
    const left = column(rect(area.x, area.y, side, area.height), leftIdx.length, gap);
    rightIdx.forEach((w, i) => { out[w] = right[i]; });
    leftIdx.forEach((w, i) => { out[w] = left[i]; });
    return out;
}

function grid(n, area, gap) {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const out = [];
    column(area, rows, gap).forEach((r, ri) => {
        const inRow = Math.min(cols, n - ri * cols);   // the last row may be shorter: its windows are wider
        out.push(...row(r, inRow, gap));
    });
    return out;
}

function threeColumns(n, area, gap) {
    const cols = Math.min(3, n);
    const colsRects = row(area, cols, gap);
    const per = Array.from({length: cols}, () => []);
    for (let i = 0; i < n; i++) per[i % cols].push(i);
    const out = new Array(n);
    per.forEach((idx, c) => column(colsRects[c], idx.length, gap).forEach((r, k) => { out[idx[k]] = r; }));
    return out;
}

/** Columns of `columnWidth` of the area, side by side; the ones that do not fit sit behind the nearest visible one (`hidden`). */
function scrolling(n, area, gap, columnWidth, focus) {
    const width = Math.max(0.15, Math.min(1, columnWidth));
    const w = (area.width - gap * (Math.floor(1 / width) - 1)) * width;
    const visible = Math.max(1, Math.floor((area.width + gap) / (w + gap)));
    const f = Math.max(0, Math.min(n - 1, focus));
    const firstVisible = Math.max(0, Math.min(n - visible, f - Math.floor((visible - 1) / 2)));
    const out = [];
    for (let i = 0; i < n; i++) {
        const at = Math.max(0, Math.min(visible - 1, i - firstVisible));
        const r = rect(area.x + at * (w + gap), area.y, w, area.height);
        if (i < firstVisible || i >= firstVisible + visible) r.hidden = true;
        out.push(r);
    }
    return out;
}

/**
 * @param layout one of LAYOUT_IDS
 * @param count how many windows
 * @param area `{x, y, width, height}`: the work area of the monitor
 * @param options `{gapInner, gapOuter, masterFactor (0.1 to 0.9), columnWidth (scrolling, share of the area), focus (index of the focused window),
 *   ratios (Dwindle: the share each split gives its first half), weights (Horizontal and Vertical: relative sizes)}`
 */
export function arrange(layout, count, area, options = {}) {
    if (count <= 0) return [];
    const gapInner = options.gapInner ?? 8;
    const gapOuter = options.gapOuter ?? 8;
    const factor = Math.max(0.1, Math.min(0.9, options.masterFactor ?? 0.55));
    // a single window does not need the gaps between tiles, only the one to the screen's edge
    const a = rect(area.x + gapOuter, area.y + gapOuter, area.width - 2 * gapOuter, area.height - 2 * gapOuter);
    switch (layout) {
    case 'master-left': return master('left', count, a, gapInner, factor);
    case 'master-right': return master('right', count, a, gapInner, factor);
    case 'center-master': return centerMaster(count, a, gapInner, factor);
    case 'grid': return grid(count, a, gapInner);
    case 'three-columns': return threeColumns(count, a, gapInner);
    case 'horizontal': return row(a, count, gapInner, options.weights);
    case 'vertical': return column(a, count, gapInner, options.weights);
    case 'scrolling': return scrolling(count, a, gapInner, options.columnWidth ?? 0.5, options.focus ?? 0);
    case 'monocle': return Array.from({length: count}, () => rect(a.x, a.y, a.width, a.height));
    default: return dwindle(count, a, gapInner, options.ratios);
    }
}

/** The area `arrange` works in: the work area less the outer gap. */
export const inner = (area, gapOuter) => rect(area.x + gapOuter, area.y + gapOuter, area.width - 2 * gapOuter, area.height - 2 * gapOuter);

/** Whether a layout lays windows side by side without overlap (all but Monocle, and Scrolling's hidden ones). */
export const overlaps = layout => layout === 'monocle';
