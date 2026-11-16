// Compares the windows a real shell tiled with what `arrange()` says they should be. Reads JSON on stdin:
// {layout, area, focus, windows: [{title, x, y, width, height}]} (windows in the order they were opened). Prints one line per problem, nothing when it all matches.
// A window may be bigger than its tile when it cannot be smaller (its own minimum size): that is respected, not a failure.
import {readFileSync} from 'node:fs';

import {arrange} from '../../shell/tile/layouts.js';

const input = JSON.parse(readFileSync(0, 'utf8'));
const {layout, area, windows} = input;
const expect = arrange(layout, windows.length, area, {gapInner: 8, gapOuter: 8, masterFactor: 0.55, columnWidth: 0.5, focus: input.focus});
const problems = [];
let constrained = 0;
windows.forEach((w, i) => {
    const e = expect[i];
    const same = Math.abs(w.x - e.x) <= 1 && Math.abs(w.y - e.y) <= 1 && Math.abs(w.width - e.width) <= 1 && Math.abs(w.height - e.height) <= 1;
    if (same)
        return;
    // a window that could not get as small as its tile: it keeps its own minimum, from the tile's corner
    if (w.width >= e.width && w.height >= e.height && Math.abs(w.x - e.x) <= 1 && Math.abs(w.y - e.y) <= 1) {
        constrained++;
        return;
    }
    // hidden Scrolling columns sit behind the nearest visible one: only their place in the stack matters
    if (e.hidden)
        return;
    problems.push(`${layout} (${windows.length} windows): ${w.title} is at ${w.x},${w.y} ${w.width}x${w.height}, wanted ${e.x},${e.y} ${e.width}x${e.height}`);
});
for (const p of problems)
    console.log(p);
if (constrained)
    console.error(`(${constrained} window(s) kept a minimum size bigger than their tile)`);
