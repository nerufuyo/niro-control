// usage: node tools/matte.mjs <A|B>   -> tex/<name>-<A|B>.png (RGBA plates) and tex/plates-<A|B>.json (box of each plate in the 7680x4320 capture, physical px)
import {writeFileSync} from 'node:fs';
import {openPage} from '../scene/lib.mjs';
const acc = process.argv[2] ?? 'A';
const PILL = [0, 0, 7680, 150], DOCK = [2700, 3900, 4980, 4320], ISL = [0, 0, 7680, 1300];
const JOBS = [['topbar-paused', 'pill-paused', PILL, true], ['topbar-playing', 'pill-playing', PILL, true], ['dock-idle', 'pill-paused', DOCK], ['dock-files', 'files', DOCK], ['dock-both', 'dock-both', DOCK],
  ['open-paused', 'open-paused', ISL, true], ['open-playing', 'open-playing', ISL, true], ['search-open', 'search-open', [2000, 300, 5700, 3800]], ['search-accent', 'search-accent', [2000, 300, 5700, 3800]], ['search-a', 'search-a', [2000, 300, 5700, 3800], false, 'AX'], ['search-acc', 'search-acc', [2000, 300, 5700, 3800], false, 'AX'],
  ['files', 'files', [0, 118, 7680, 4150]], ['editor', 'editor', [0, 118, 7680, 4150]], ['panel-look', 'panel-look', [0, 118, 7680, 4150]]];
import {readFileSync, existsSync} from 'node:fs';
const only = process.argv.slice(3), WD = {files: acc === 'A' ? 'A' : 'W-B-files', editor: `W-${acc}-editor`, 'panel-look': `W-${acc}-panel`, 'dock-both': `W-${acc}-both`};
const pj = `tex/plates-${acc}.json`, p = await openPage('wide', 1, '', '/tools/matte.html'), boxes = existsSync(pj) ? JSON.parse(readFileSync(pj)) : {};
for (const [name, src, reg, cut, dir0] of JOBS) {
  const dir = dir0 ?? WD[name]; if (dir0 && acc !== 'A') continue; if (only.length && !only.includes(name)) continue;
  const r = await p.call('Runtime.evaluate', {expression: `matte('/assets/shots3/${dir ?? acc}/${src}-k.png','/assets/shots3/${dir ?? acc}/${src}-w.png',${JSON.stringify(reg)},${!!cut})`, awaitPromise: true, returnByValue: true});
  if (r.exceptionDetails || !r.result.value) { console.log('FAILED', name, r.exceptionDetails?.exception?.description ?? 'empty'); continue; }
  writeFileSync(`tex/${name}-${acc}.png`, Buffer.from(r.result.value.png.split(',')[1], 'base64')); boxes[name] = r.result.value.box; console.log(name, r.result.value.box.join(' '));
}
writeFileSync(`tex/plates-${acc}.json`, JSON.stringify(boxes)); p.close();
