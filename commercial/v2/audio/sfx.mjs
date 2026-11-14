// Subtle sound design, timed to the music-sync map (analysis.json), written as sfx.wav (48 kHz stereo). Pure synthesis: no samples, nothing copyrighted.
import {readFileSync, writeFileSync} from 'node:fs';
const A = JSON.parse(readFileSync('analysis.json')), E = A.events, SR = 48000, N = 45 * SR, L = new Float32Array(N), R = new Float32Array(N);
const strong = A.onsets.filter(o => o.s > 1.0).map(o => o.t), snap = (t, tol = .2) => { let b = null; for (const o of strong) { const d = Math.abs(o - t); if (d <= tol && (!b || d < b.d)) b = {t: o, d}; } return b ? b.t : t; };
let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;
const add = (t, dur, fn, g = 1, pan = 0) => { const i0 = Math.max(0, Math.round(t * SR)), n = Math.round(dur * SR); for (let i = 0; i < n && i0 + i < N; i++) { const x = i / SR, v = fn(x, i / n) * g; L[i0 + i] += v * (1 - Math.max(0, pan)); R[i0 + i] += v * (1 + Math.min(0, pan)); } };
const env = (k, a, d) => Math.min(1, k / a) * Math.exp(-k * d);
const sine = (f, x) => Math.sin(2 * Math.PI * f * x);
// one-pole filters for noise sweeps
const whoosh = (t, dur, f0, f1, g, pan = 0) => { let lp = 0, bp = 0; add(t, dur, (x, k) => { const f = f0 * Math.pow(f1 / f0, k), a = Math.min(.95, 2 * Math.PI * f / SR); lp += a * (rnd() - lp); bp += a * (lp - bp); return (lp - bp) * 9 * Math.sin(Math.PI * k) ** 2; }, g, pan); };
const bell = (t, f, g, dur = 1.6, pan = 0) => add(t, dur, x => (sine(f, x) + .5 * sine(f * 2.76, x) * Math.exp(-x * 5) + .25 * sine(f * 5.4, x) * Math.exp(-x * 9)) * env(x, .004, 3.2), g, pan);
const click = (t, g, f = 1800) => add(t, .06, x => (rnd() * .5 + sine(f, x)) * env(x, .001, 90), g);
const thump = (t, f, g, dur = .5) => add(t, dur, x => sine(f * (1 + .6 * Math.exp(-x * 14)), x) * env(x, .004, 7), g);
const shimmer = (t, dur, g) => add(t, dur, (x, k) => { let v = 0; for (const f of [2093, 2637, 3136, 4186]) v += sine(f * (1 + .003 * Math.sin(x * 7 + f)), x) * (.5 + .5 * Math.sin(x * 11 + f)); return v * Math.sin(Math.PI * Math.min(1, k * 1.4)) ** 2 * (1 - k) ; }, g);
// --- the picture's beats
whoosh(.4, 2.2, 400, 6000, .13); shimmer(E.glassAppear - .2, 2.6, .018); bell(E.glassAppear, 1568, .025);
whoosh(4.3, 1.2, 300, 3500, .1); thump(E.islandBirth, 70, .22, .9); bell(E.islandBirth + .02, 1318, .05); shimmer(E.islandBirth, 1.6, .02);
const pill = snap(9.15); click(pill, .09, 1500); whoosh(pill + .02, .9, 500, 2500, .06); thump(pill + .05, 90, .08, .4);
click(E.playClick, .14, 2200); bell(E.playClick + .03, 1760, .035); shimmer(E.wavesStart, 1.8, .02);
whoosh(E.passThrough - .5, 1.1, 250, 5000, .2); thump(E.passThrough, 48, .3, 1.2); bell(E.passThrough + .1, 2093, .035, 2.2);
whoosh(E.dockRise - .1, .7, 600, 2400, .06); click(E.dockRise + .5, .05, 3000);
click(E.appLaunch, .1, 1300); thump(E.appLaunch + .02, 120, .1, .35); whoosh(E.appLaunch, .8, 350, 1800, .07);
whoosh(snap(22.5), 1.3, 300, 3000, .08, .4);
whoosh(E.glassWorld - .3, 3.5, 500, 3800, .08, -.3); bell(E.glassWorld, 1175, .025, 2.4);
whoosh(E.searchOpen - .9, 1.0, 700, 3000, .07); click(E.searchOpen, .1, 2600); thump(E.searchOpen, 140, .05, .25);
for (const dt of [.95, 1.1, 1.22, 1.4, 1.52]) click(E.searchOpen + dt, .04, 2900 + 300 * Math.sin(dt * 40));
bell(E.searchResult, 1976, .05, 1.2); click(E.searchResult, .08, 3400);
whoosh(E.appearanceShift - .4, 1.8, 400, 6500, .13); shimmer(E.appearanceShift, 2.2, .025); bell(E.appearanceShift + .1, 1480, .03, 2.4);
click(E.appearanceShift + .7, .08); click(E.appearanceShift + 1.9, .08);
click(E.profileSwitch - 1.0, .08); click(E.profileSwitch - .02, .1, 1500); thump(E.profileSwitch, 62, .18, .8); whoosh(E.profileSwitch + .2, 1.3, 1500, 300, .06);
whoosh(E.logoReveal - .9, 1.0, 300, 7000, .16); thump(E.logoReveal, 44, .34, 2.6); bell(E.logoReveal + .02, 1046, .06, 3.4); bell(E.logoReveal + .02, 2093, .03, 3.4); shimmer(E.logoReveal + .1, 3, .02);
// gentle limiter so nothing spikes over the music
const out = Buffer.alloc(N * 4); for (let i = 0; i < N; i++) { const f = (v) => Math.max(-1, Math.min(1, Math.tanh(v * 1.2) * .9)); out.writeInt16LE(Math.round(f(L[i]) * 32767), i * 4); out.writeInt16LE(Math.round(f(R[i]) * 32767), i * 4 + 2); }
const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + out.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(out.length, 40);
writeFileSync('sfx.wav', Buffer.concat([h, out])); console.log('sfx.wav written');
