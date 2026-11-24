// Checks the geometry dumped by dock-motion-steps.sh (mag-N.json, read from actors at settled pointer positions) against the
// shared engine: Gaussian scale per icon, neighbours never overlapping, the magnified bump centred on the pointer.
//   usage: node tests/shell/dock-analyze.mjs <outdir> [maxScale=1.4] [falloff=100]
import {readdirSync, readFileSync} from 'node:fs';
import {gaussianScale} from '../../shell/shared/motionEngine.js';

const dir = process.argv[2], amp = (Number(process.argv[3]) || 1.4) - 1, sigma = (Number(process.argv[4]) || 100) * 0.62;
let worstScale = 0, worstGap = Infinity, rows = 0;
for (const f of readdirSync(dir).filter(n => /^mag-\d+\.json$/.test(n)).sort()) {
    const {pointer, geom} = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    const local = pointer[0] - geom.bx;
    let err = 0;
    for (const k of geom.kids) {
        const want = gaussianScale(Math.abs(k.x + k.w / 2 - local), amp, sigma);
        err = Math.max(err, Math.abs(want - k.s));
    }
    let gap = Infinity;
    for (let i = 1; i < geom.kids.length; i++) gap = Math.min(gap, geom.kids[i].left - geom.kids[i - 1].right);
    const peak = geom.kids.reduce((a, k) => (k.s > a.s ? k : a));
    console.log(`${f}: pointer x=${pointer[0]} (local ${local.toFixed(0)}), peak icon ${peak.i} scale ${peak.s}, max |scale - gaussian| = ${err.toFixed(4)}, min neighbour gap = ${gap.toFixed(2)} px`);
    worstScale = Math.max(worstScale, err); worstGap = Math.min(worstGap, gap); rows++;
}
console.log(`positions=${rows} worst scale error=${worstScale.toFixed(4)} worst gap=${worstGap.toFixed(2)} px`);
process.exitCode = rows && worstGap >= 0 && worstScale < 0.03 ? 0 : 1;
