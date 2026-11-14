// An original temporary soundtrack for the NIRO commercial (NOT the requested licensed recording): 45 s at 120 BPM, D minor, every scene
// change on a bar line. Writes music.wav (no effects), sfx.wav, master.wav, envelope.json (the music's amplitude, 60 per second, which
// drives the waveform in the film) and cues.json (the beat grid and the scene cues the film is timed to). Pure Node, no dependencies.
import {writeFileSync} from 'node:fs';
const SR = 48000, DUR = 45, N = SR * DUR, BPM = 120, BEAT = 60 / BPM;
const L = new Float32Array(N), R = new Float32Array(N), SL = new Float32Array(N), SRr = new Float32Array(N);   // music L/R, sfx L/R
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 * 2 - 1;
const hz = m => 440 * 2 ** ((m - 69) / 12), clamp = (x, a, b) => Math.min(b, Math.max(a, x)), TAU = Math.PI * 2;
const env = (t, a, d, s, r, len) => t < 0 ? 0 : t < a ? t / a : t < a + d ? 1 - (1 - s) * (t - a) / d : t < len ? s : t < len + r ? s * (1 - (t - len) / r) : 0;
function add(buf, bufR, t0, dur, fn, gain = 1, pan = 0) {
    const i0 = Math.floor(t0 * SR), i1 = Math.min(N, Math.floor((t0 + dur) * SR)), gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
    for (let i = Math.max(0, i0); i < i1; i++) { const v = fn((i - i0) / SR, i); buf[i] += v * gl; bufR[i] += v * gr; }
}
const M = (t0, dur, fn, g, p) => add(L, R, t0, dur, fn, g, p), S = (t0, dur, fn, g, p) => add(SL, SRr, t0, dur, fn, g, p);
// ---- voices
const saw = ph => 2 * (ph - Math.floor(ph + 0.5)), sine = ph => Math.sin(TAU * ph);
const padVoice = (f, len) => t => { const e = env(t, 0.6, 0.5, 0.8, 0.9, len); return e * (saw(f * t) + saw(f * 1.004 * t + 0.2) + saw(f * 0.996 * t + 0.6)) / 3 * (0.55 + 0.45 * Math.sin(TAU * 0.13 * t)); };
const bass = (f, len) => t => { const e = env(t, 0.005, 0.12, 0.6, 0.08, len); return e * (sine(f * t) * 0.8 + sine(2 * f * t) * 0.18 + Math.tanh(saw(f * t) * 2) * 0.12); };
const pluck = (f, len) => t => { const e = Math.exp(-t * 9) * env(t, 0.002, 0.01, 1, 0.02, len); return e * (sine(f * t) + 0.5 * sine(2 * f * t + 0.1) * Math.exp(-t * 14) + 0.25 * sine(3 * f * t)); };
const bell = (f, len) => t => { const e = Math.exp(-t * 2.3); return e * (sine(f * t + 0.8 * sine(f * 3.5 * t) * Math.exp(-t * 4)) * 0.8 + sine(f * 2.01 * t) * 0.25 * Math.exp(-t * 3)); };
const kick = t => { const f = 45 + 110 * Math.exp(-t * 28); return Math.tanh(1.6 * Math.sin(TAU * (45 * t + 110 / 28 * (1 - Math.exp(-t * 28))))) * Math.exp(-t * 7.5); };
const clap = t => (rnd() * 0.9) * (Math.exp(-t * 22) + 0.6 * Math.exp(-((t - 0.012) ** 2) * 9000)) * 0.9;
const hat = t => rnd() * Math.exp(-t * 70) * 0.5;
const noiseBand = (lo, hi, len) => { let a = 0, b = 0; return t => { const x = rnd(), k1 = clamp(lo, 20, 18000) / SR * TAU, k2 = clamp(hi, 20, 18000) / SR * TAU; a += (x - a) * clamp(k2, 0, 1); b += (a - b) * clamp(k1, 0, 1); return a - b; }; };
// ---- the song: chords per bar (2 s): Dm Bb F C
const CH = [[50, 53, 57, 62], [46, 50, 53, 58], [53, 57, 60, 65], [48, 52, 55, 60]], ROOT = [38, 34, 41, 36];
const bar = b => b % 4;
const hook = [74, 77, 76, 74, 72, 74, 77, 79, 81, 79, 77, 76, 74, 72, 74, 69];   // an original 2-bar hook (eighth notes), A5 above D minor
// build-up and groove by section; times in seconds, all on bar lines
const sec = t => t < 5 ? 'intro' : t < 9 ? 'form' : t < 17 ? 'hero' : t < 23 ? 'reveal' : t < 29 ? 'glass' : t < 34 ? 'search' : t < 40 ? 'custom' : 'final';
for (let b = 0; b < 23; b++) {
    const t0 = b * 2, s = sec(t0), c = CH[bar(b)];
    // pads: always, brighter as the film opens up
    const padG = s === 'intro' ? 0.10 + 0.05 * t0 / 5 : s === 'final' ? 0.2 : 0.15;
    for (const [k, n] of c.entries()) M(t0, 2.6, padVoice(hz(n + 12), 2.0), padG * 0.5, (k - 1.5) * 0.35);
    if (t0 >= 3) M(t0, 2.2, bass(hz(ROOT[bar(b)]), 1.9), s === 'intro' ? 0.0 : 0.38);
    for (let q = 0; q < 4; q++) {
        const tb = t0 + q * BEAT;
        const groove = ['hero', 'reveal', 'glass', 'search', 'custom', 'final'].includes(s), light = s === 'form';
        if (groove || (light && b >= 3)) { M(tb, 0.35, kick, groove ? 0.62 : 0.28); }
        if (groove && (q === 1 || q === 3)) M(tb, 0.25, clap, 0.22, 0.1);
        if (groove) for (let e = 0; e < 2; e++) M(tb + e * BEAT / 2, 0.08, hat, e ? 0.12 : 0.07, 0.3);
        if (groove && ['hero', 'reveal', 'final'].includes(s)) for (let e = 0; e < 2; e++) M(tb + e * BEAT / 2 + BEAT / 4, 0.5, bass(hz(ROOT[bar(b)]), 0.12), 0.18);
        if (s === 'search') for (let e = 0; e < 4; e++) M(tb + e * BEAT / 4, 0.05, hat, 0.09 * (e % 2 ? 0.7 : 1), -0.3);
    }
    // arp: 16ths from the form scene on
    if (s !== 'intro') for (let i = 0; i < 16; i++) { const n = c[[0, 1, 2, 3, 2, 1][i % 6]] + 24; if (s === 'form' && i % 2) continue; M(t0 + i * BEAT / 4, 0.45, pluck(hz(n), 0.1), s === 'hero' || s === 'search' ? 0.13 : 0.09, Math.sin(i) * 0.4); }
    // the hook: the hero, the customisation and the final bars
    if (['hero', 'custom', 'final'].includes(s) && b % 2 === 0) hook.slice(0, 8).forEach((n, i) => M(t0 + i * BEAT / 2, 0.6, pluck(hz(n), 0.25), 0.2, 0.25));
    if (['hero', 'custom', 'final'].includes(s) && b % 2 === 1) hook.slice(8).forEach((n, i) => M(t0 + i * BEAT / 2, 0.6, pluck(hz(n), 0.25), 0.2, 0.25));
}
// the first seconds: a blue point of light, a few glass notes; and a riser into 40 s and out of the hero (15.5 to 17)
[[0.7, 86], [1.7, 91], [2.5, 93], [3.4, 98], [4.2, 105]].forEach(([t, n]) => M(t, 3, bell(hz(n), 2.8), 0.12 + 0.04 * (t / 4), (t % 2) - 0.5));
M(0, 5, t => 0.22 * sine(41 * t) * env(t, 3.5, 0.5, 0.9, 1.0, 4.5), 1);
const riser = (a, b, g) => M(a, b - a, (() => { const n = noiseBand(300, 8000); return t => n(t) * (t / (b - a)) ** 2.2 * g * 6; })(), 1);
riser(15, 17, 0.12); riser(38, 40, 0.14); riser(3, 5, 0.06);
// the final chord and its tail
for (const n of [50, 57, 62, 65, 69, 74]) M(40, 5.2, padVoice(hz(n), 3.6), 0.2, (n % 5 - 2) * 0.2);
M(40, 0.6, kick, 0.9); M(40, 3, bass(hz(26), 2.2), 0.5);
// ---- SFX stem
const whoosh = (t0, dur, up = true, g = 0.34) => S(t0, dur, (() => { const n = noiseBand(200, 6000); return t => { const x = t / dur, f = up ? x : 1 - x; return n(t) * Math.sin(Math.PI * x) ** 1.6 * g * (0.4 + f); }; })(), 1, up ? -0.4 : 0.4);
const tick = (t0, f = 2600, g = 0.28) => S(t0, 0.06, t => sine(f * t) * Math.exp(-t * 90) * g + rnd() * Math.exp(-t * 300) * g * 0.4, 1, 0);
const chime = (t0, n, g = 0.24) => S(t0, 2.5, bell(hz(n), 2.4), g, 0.2);
const pop = (t0, g = 0.4) => S(t0, 0.3, t => sine((190 - 120 * t) * t) * Math.exp(-t * 14) * g + sine(900 * t) * Math.exp(-t * 60) * g * 0.3, 1, 0);
[5, 9, 17, 23, 29, 34, 40].forEach((t, i) => whoosh(t - 0.7, 0.7, true, i === 6 ? 0.5 : 0.34));
chime(0.45, 105, 0.2); chime(4.6, 93, 0.24);
pop(5.0, 0.5); S(5.0, 1.2, t => sine(55 * t) * Math.exp(-t * 3) * 0.55, 1);                  // the island forms
tick(10.4, 1900, 0.3); pop(10.55, 0.36); whoosh(12.4, 0.5, false, 0.2); pop(14.9, 0.3);      // play, the island opens, collapses
for (let i = 0; i < 8; i++) tick(17.6 + i * 0.12, 1500 + i * 130, 0.1);                       // dock magnification
pop(19.9, 0.3); whoosh(19.6, 0.5, true, 0.22);                                              // an app opens
chime(24.5, 98, 0.12); chime(26.0, 105, 0.1);                                               // glass
tick(29.35, 900, 0.34); tick(29.4, 1400, 0.3); pop(29.7, 0.4);                              // Super+Space, the palette
'fire'.split('').forEach((c, i) => tick(30.3 + i * 0.13, 2200 + i * 90, 0.2)); '2*pi'.split('').forEach((c, i) => tick(31.9 + i * 0.1, 2300 + i * 70, 0.16)); pop(33.2, 0.24);
chime(34.9, 98, 0.2); chime(35.9, 101, 0.2); tick(36.6, 1800, 0.3); chime(38.5, 105, 0.22);   // accent, preset, profile
S(40, 4.6, t => (sine(65 * t) * 0.6 + sine(130 * t) * 0.2) * Math.exp(-t * 1.2) * 0.7, 1); chime(40.1, 86, 0.3); chime(40.3, 98, 0.22);
// ---- reverb on the music (Schroeder: 4 combs + 2 allpasses), a little on the sfx
function reverb(buf, mix) {
    const dl = [1557, 1617, 1491, 1422].map(d => new Float32Array(d)), pos = [0, 0, 0, 0], ap = [225, 556].map(d => new Float32Array(d)), ap2 = [0, 0];
    for (let i = 0; i < N; i++) {
        const x = buf[i]; let s = 0;
        for (let k = 0; k < 4; k++) { const y = dl[k][pos[k]]; dl[k][pos[k]] = x * 0.3 + y * 0.84; pos[k] = (pos[k] + 1) % dl[k].length; s += y; }
        for (let k = 0; k < 2; k++) { const y = ap[k][ap2[k]]; const z = s + 0.5 * y; ap[k][ap2[k]] = z * -0.5 + y * 0 + s; s = y - 0.5 * z; ap2[k] = (ap2[k] + 1) % ap[k].length; }
        buf[i] = x + s * mix * 0.25;
    }
}
reverb(L, 0.5); reverb(R, 0.5); reverb(SL, 0.28); reverb(SRr, 0.28);
// ---- the mix: a side-chain duck of the pads is already implicit in the groove; master limiter and a fade
const fade = i => { const t = i / SR; return Math.min(1, t / 0.15) * (t > 43.6 ? Math.max(0, (45 - t) / 1.4) : 1); };
const out = {music: [L, R], sfx: [SL, SRr]}, mixL = new Float32Array(N), mixR = new Float32Array(N);
let peak = 0; for (let i = 0; i < N; i++) { mixL[i] = L[i] * 0.55 + SL[i]; mixR[i] = R[i] * 0.55 + SRr[i]; peak = Math.max(peak, Math.abs(mixL[i]), Math.abs(mixR[i])); }
const norm = 0.89 / peak;
function wav(path, l, r, g) {
    const b = Buffer.alloc(44 + N * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + N * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(N * 4, 40);
    for (let i = 0; i < N; i++) { const f = fade(i) * g; b.writeInt16LE(Math.round(clamp(Math.tanh(l[i] * f) * 0.98, -1, 1) * 32767), 44 + i * 4); b.writeInt16LE(Math.round(clamp(Math.tanh(r[i] * f) * 0.98, -1, 1) * 32767), 46 + i * 4); }
    writeFileSync(path, b);
}
let mp = 0; for (let i = 0; i < N; i++) mp = Math.max(mp, Math.abs(L[i]), Math.abs(R[i]));
wav('music.wav', L, R, 0.85 / mp);                                                            // the music alone, normalised
wav('sfx.wav', SL, SRr, 1.0);
wav('master.wav', mixL, mixR, norm * 0.9);
// ---- amplitude envelope of the music stem (RMS over 1/60 s windows) and the cue sheet
const env60 = []; for (let f = 0; f < DUR * 60; f++) { let s = 0; const a = Math.floor(f / 60 * SR), n = Math.floor(SR / 60); for (let i = a; i < Math.min(N, a + n); i++) s += (L[i] * L[i] + R[i] * R[i]) / 2; env60.push(Math.sqrt(s / n)); }
const mx = Math.max(...env60); writeFileSync('envelope.json', JSON.stringify({fps: 60, values: env60.map(v => +(v / mx).toFixed(4))}));
writeFileSync('cues.json', JSON.stringify({bpm: BPM, beat: BEAT, scenes: {awakening: 0, island: 5, music: 9, desktop: 17, glass: 23, search: 29, personal: 34, final: 40, end: 45}, beats: Array.from({length: 90}, (_, i) => +(i * BEAT).toFixed(3)),
    cues: {play: 10.4, expand: 10.55, collapse: 14.9, dock: 17.6, app: 19.9, palette: 29.4, type: 30.3, calc: 31.9, accent: 34.9, preset: 35.9, profile: 38.5, logo: 40.1}}, null, 1));
console.log(`music, sfx, master written (${DUR}s, ${SR} Hz stereo); peak ${peak.toFixed(2)}`);
