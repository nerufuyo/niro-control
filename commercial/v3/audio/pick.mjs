// V3 excerpt search: the 45 s window whose energy arc fits the film's story (quiet opening, a chorus entry at ~9 s, a change at ~33 s, a resolution at ~42 s)
import {readFileSync} from 'node:fs';
const A = JSON.parse(readFileSync('analysis-full.json')), R = A.fps100.rms, on = A.onsets.filter(o => o.s > 1.0);
const m = (a, b) => { let s = 0, n = 0; for (let i = Math.round(a * 100); i < Math.round(b * 100); i++) { s += R[i] ?? 0; n++; } return s / Math.max(1, n); };
const res = [];
for (let s = 5; s < A.duration - 46; s += 0.1) {
  const quiet = m(s + .6, s + 7), pre = m(s + 6.5, s + 8.8), post = m(s + 9, s + 12), rise = post - pre, opening = m(s, s + .6);
  const play = on.filter(o => o.t - s > 8.7 && o.t - s < 10.3).sort((a, b) => b.s - a.s)[0];
  const tr = Math.abs(m(s + 33.2, s + 35) - m(s + 31, s + 33)), end = m(s + 38, s + 41.6) - m(s + 42.4, s + 44.8);
  const score = (0.3 - quiet) * 14 + rise * 18 + (play ? Math.min(1, play.s / 150) * 2 : -3) + tr * 8 + end * 10 - Math.max(0, opening - .22) * 8;
  res.push({s: +s.toFixed(1), score: +score.toFixed(2), quiet: +quiet.toFixed(2), rise: +rise.toFixed(2), play: play ? [+(play.t - s).toFixed(2), +play.s.toFixed(0)] : null, tr: +tr.toFixed(2), end: +end.toFixed(2)});
}
res.sort((a, b) => b.score - a.score); console.log(res.slice(0, 8));
