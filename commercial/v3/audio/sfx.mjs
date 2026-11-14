// Subtle sound design, timed to the music-sync map (analysis.json), written as sfx.wav (48 kHz stereo). Pure synthesis: no samples, nothing copyrighted.
import {readFileSync, writeFileSync} from 'node:fs';
const A = JSON.parse(readFileSync('sync.json')), E = A.events, SR = 48000, N = 45 * SR, L = new Float32Array(N), R = new Float32Array(N);
const strong = A.onsets.filter(o => o.s > 40).map(o => o.t), snap = (t, tol = .2) => { let b = null; for (const o of strong) { const d = Math.abs(o - t); if (d <= tol && (!b || d < b.d)) b = {t: o, d}; } return b ? b.t : t; };
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
// --- the picture's beats (V3): few, small, motivated by what the picture does
whoosh(E.sweep - 1.0, 1.8, 500, 7000, .1); shimmer(E.sweep - .4, 2.0, .014); bell(E.sweep + .02, 1568, .02);
click(E['pill-click'], .08, 1500); thump(E['pill-click'] + .03, 90, .08, .4); whoosh(E['pill-click'], .7, 500, 2500, .05);
click(E.play, .14, 2200); bell(E.play + .03, 1760, .03); thump(E.play, 70, .12, .5);
whoosh(E.pullback - .1, 1.8, 250, 4200, .09); click(E['dock-in'] + .1, .05, 3000); thump(E['dock-in'], 60, .1, .6);
click(E.launch, .1, 1300); thump(E.launch + .02, 120, .08, .3);
click(E['file-click'], .05, 1700); click(E['editor-open'] - .12, .05, 1700); click(E['editor-open'] - .02, .06, 1700); thump(E['editor-open'], 110, .08, .3); whoosh(E['editor-open'], .5, 700, 2600, .04);
whoosh(E.drag, 1.5, 600, 2200, .05, .3);
click(E['search-open'], .09, 2600); thump(E['search-open'], 140, .05, .25); for (const dt of [.52, .67, .82, .97, 1.12, 1.27]) click(E['search-open'] + dt, .035, 2900 + 300 * Math.sin(dt * 40));
bell(E.result, 1976, .04, 1.1); click(E.enter, .08, 2400);
click(E.accent, .1, 1900); whoosh(E.accent - .1, 1.6, 400, 6500, .12); shimmer(E.accent, 2.0, .022); bell(E.accent + .08, 1480, .03, 2.2);
whoosh(E['cut-s12'] - .8, .8, 300, 6500, .1); thump(E['cut-s12'], 44, .3, 2.4); bell(E['cut-s12'] + .02, 1046, .05, 3.2); bell(E['cut-s12'] + .02, 2093, .025, 3.2);
// gentle limiter so nothing spikes over the music
const out = Buffer.alloc(N * 4); for (let i = 0; i < N; i++) { const f = (v) => Math.max(-1, Math.min(1, Math.tanh(v * 1.2) * .9)); out.writeInt16LE(Math.round(f(L[i]) * 32767), i * 4); out.writeInt16LE(Math.round(f(R[i]) * 32767), i * 4 + 2); }
const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + out.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(out.length, 40);
writeFileSync('sfx.wav', Buffer.concat([h, out])); console.log('sfx.wav written');
