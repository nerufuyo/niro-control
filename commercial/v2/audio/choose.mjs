// Picks the 45 s excerpt and builds the music-sync map. Usage: node choose.mjs
import {readFileSync, writeFileSync} from 'node:fs';
const A = JSON.parse(readFileSync('analysis-full.json')), R = A.fps100.rms, L = A.fps100.low, F = A.fps100.flux;
const grid = (bpm, off) => ({bpm, per: 60 / bpm, off});
// tempo octave check: how many strong onsets sit within 45 ms of each candidate grid
const strong = A.onsets.filter(o => o.s > 1.0);
const cand = [A.tempo / 2, A.tempo, A.tempo * 2 / 3, A.tempo * 4 / 3, A.tempo * 2].map(b => { const per = 60 / b; let best = 0, bo = 0; for (let o = 0; o < per; o += .005) { let c = 0; for (const s of strong) { const d = ((s.t - o) % per + per) % per; if (Math.min(d, per - d) < .045) c++; } if (c > best) { best = c; bo = o; } } return {bpm: +b.toFixed(2), per, off: bo, hit: best / strong.length}; });
console.log('grid candidates', cand.map(c => `${c.bpm}bpm:${(c.hit * 100).toFixed(0)}%`).join('  '), 'strong onsets', strong.length);
const g = cand[1]; // detected tempo; the log above shows how well it explains the onsets
const mean = (a, b) => { let s = 0; for (let i = Math.round(a * 100); i < Math.round(b * 100); i++) s += R[i] ?? 0; return s / Math.max(1, (b - a) * 100); };
const bar = g.per * 4; let best = null;
for (let k = 0; ; k++) { const s = g.off + k * bar; if (s + 45 > A.duration - 1) break; if (s < 0) continue;
  const intro = mean(s, s + 4), rise = mean(s + 5, s + 9), hero = mean(s + 10, s + 17), end = mean(s + 38, s + 44), whole = mean(s, s + 45);
  const score = (rise / Math.max(intro, .05)) * 1.0 + hero * 3 + end * 2 - Math.abs(whole - .3) * 2; if (!best || score > best.score) best = {s, score, intro, rise, hero, end}; }
console.log('excerpt', best);
const t0 = best.s, tt = t => +(t - t0).toFixed(3);
const beats = []; for (let t = g.off + Math.ceil((t0 - g.off) / g.per) * g.per; t < t0 + 45; t += g.per) beats.push(tt(t));
const downbeats = beats.filter((_, i) => i % 4 === 0), onsets = A.onsets.filter(o => o.t >= t0 && o.t < t0 + 45).map(o => ({t: tt(o.t), s: o.s}));
// energy peaks / phrase markers on 0.5 s smoothed rms
const sm = []; for (let t = t0; t < t0 + 45; t += .25) sm.push({t: tt(t), v: mean(t, t + .5)}); const peaks = sm.filter((p, i) => i > 4 && i < sm.length - 4 && p.v > sm[i - 4].v * 1.12 && p.v >= sm[i - 1].v && p.v >= sm[i + 1].v).map(p => p.t);
const phrases = downbeats.filter((_, i) => i % 2 === 0); // 2-bar phrases
// ---- event map: each visual hit goes to the strongest onset within +-0.18 s of a target, else the nearest beat
const near = (t, list, tol) => { let b = null; for (const x of list) { const d = Math.abs((x.t ?? x) - t); if (d <= tol && (!b || d < b.d)) b = {t: x.t ?? x, d}; } return b?.t ?? null; };
const sn = onsets.filter(o => o.s > 1.0), snap = (t, tol = .22) => near(t, sn, tol) ?? near(t, beats, tol) ?? t;
const want = {glassAppear: 0.9, islandBirth: 5.0, playClick: 10.4, islandExpand: 10.55, wavesStart: 11.2, passThrough: 17.0, dockRise: 18.4, appLaunch: 20.6, glassWorld: 25.0, searchOpen: 31.0, searchResult: 33.3, appearanceShift: 35.4, profileSwitch: 38.2, logoReveal: 41.0};
const events = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, +snap(v).toFixed(3)]));
writeFileSync('analysis.json', JSON.stringify({source: A.file, fullDuration: A.duration, tempo: g.bpm, beatPeriod: +g.per.toFixed(4), gridFit: +g.hit.toFixed(2), excerptStart: +t0.toFixed(3), excerptEnd: +(t0 + 45).toFixed(3), beats, downbeats, phrases, energyPeaks: peaks, onsets, events, envelope60: Array.from({length: 2700}, (_, i) => +(mean(t0 + i / 60 - .008, t0 + i / 60 + .008)).toFixed(4)), low60: Array.from({length: 2700}, (_, i) => +(L[Math.round((t0 + i / 60) * 100)] ?? 0).toFixed(2)), flux60: Array.from({length: 2700}, (_, i) => +(F[Math.round((t0 + i / 60) * 100)] ?? 0).toFixed(3))}));
console.log({t0, beats: beats.length, phrases, energyPeaks: peaks, events});
