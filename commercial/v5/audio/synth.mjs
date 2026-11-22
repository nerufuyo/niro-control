// An original soundtrack for the NIRO commercial v4 (all synthesised here, no samples, no licensed material): exactly 60 s at 120 BPM,
// D minor, 30 bars of 2 s, every section change on a bar line. Cheerful but calm: soft plucks, warm pad, round bass, little bells.
// Writes music.wav (no sfx), sfx.wav, master.wav (music + sfx, loudnorm -16 LUFS, <= -1 dBTP via ffmpeg), envelope.json (3600 values,
// 60 per second, 0..1) and cues.json. Pure Node, no dependencies (ffmpeg is only used for the final loudness pass).
import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const OUT = dirname(fileURLToPath(import.meta.url));
const SR = 48000, DUR = 60, N = SR * DUR, BPM = 120, BEAT = 60 / BPM, BAR = BEAT * 4;
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
const padVoice = (f, len) => t => { const e = env(t, 0.7, 0.5, 0.8, 0.9, len); return e * (saw(f * t) + saw(f * 1.004 * t + 0.2) + saw(f * 0.996 * t + 0.6)) / 3 * (0.55 + 0.45 * Math.sin(TAU * 0.13 * t)); };
const bass = (f, len) => t => { const e = env(t, 0.008, 0.15, 0.6, 0.1, len); return e * (sine(f * t) * 0.85 + sine(2 * f * t) * 0.12); };
const pluck = (f, len) => t => { const e = Math.exp(-t * 9) * env(t, 0.003, 0.01, 1, 0.03, len); return e * (sine(f * t) + 0.4 * sine(2 * f * t + 0.1) * Math.exp(-t * 14) + 0.15 * sine(3 * f * t)); };
const bell = (f, len) => t => { const e = Math.exp(-t * 2.3) * Math.min(1, t / 0.003); return e * (sine(f * t + 0.6 * sine(f * 3.5 * t) * Math.exp(-t * 4)) * 0.8 + sine(f * 2.01 * t) * 0.2 * Math.exp(-t * 3)); };
const kick = t => Math.tanh(1.3 * Math.sin(TAU * (45 * t + 110 / 28 * (1 - Math.exp(-t * 28))))) * Math.exp(-t * 8) * Math.min(1, t / 0.002);
const snap = () => { let a = 0, b = 0; return t => { const x = rnd(); a += (x - a) * 0.45; b += (a - b) * 0.08; return (a - b) * 2.2 * Math.exp(-t * 26) * Math.min(1, t / 0.002); }; };
const hat = t => rnd() * Math.exp(-t * 80) * 0.5 * Math.min(1, t / 0.001);
// ---- the song: chords per bar: Dm Bb F C
const CH = [[50, 53, 57, 62], [46, 50, 53, 58], [53, 57, 60, 65], [48, 52, 55, 60]], ROOT = [38, 34, 41, 36];
// hooks: eight eighth-notes per bar, null is a rest (breathing room keeps it light); A = main hook, B = variation / peak
const HOOK_A = [[81, null, 77, 81, 86, null, 81, null], [82, null, 77, 82, 86, null, 82, null], [81, null, 77, 81, 84, null, 81, null], [79, null, 76, 79, 84, null, 79, 76]];
const HOOK_B = [[86, null, 84, 81, 77, null, 81, 84], [86, null, 82, 77, 74, null, 77, 82], [84, null, 81, 77, 81, null, 84, 89], [88, null, 84, 79, 76, null, 79, 84]];
// sections: [first bar, end bar, name]; 2 s per bar, so 0 6 14 24 32 38 46 54 60 s
const SECTIONS = [[0, 3, 'intro'], [3, 7, 'beat'], [7, 12, 'full'], [12, 16, 'full-var'], [16, 19, 'break'], [19, 23, 'groove'], [23, 27, 'peak'], [27, 30, 'outro']];
const secOf = b => SECTIONS.find(s => b >= s[0] && b < s[1])[2];
for (let b = 0; b < 30; b++) {
    const t0 = b * BAR, s = secOf(b), c = CH[b % 4], rel = b - SECTIONS.find(x => x[2] === s)[0];
    if (s === 'outro') continue;                                                   // the closing chord is written below
    // pad: always, warmer and fuller as the song opens up
    const padG = { intro: 0.17, beat: 0.17, full: 0.16, 'full-var': 0.16, break: 0.2, groove: 0.17, peak: 0.19 }[s];
    for (const [k, n] of c.entries()) M(t0, 2.7, padVoice(hz(n + 12), 2.0), padG * 0.5, (k - 1.5) * 0.35);
    // bass: from 6 s, gone in the first break bar
    if (s !== 'intro' && !(s === 'break' && rel === 0)) {
        M(t0, 2.2, bass(hz(ROOT[b % 4]), 1.9), 0.34);
        if (['full', 'full-var', 'groove', 'peak'].includes(s)) for (let e = 0; e < 4; e++) M(t0 + e * BEAT + BEAT * 0.75, 0.3, bass(hz(ROOT[b % 4] + (e % 2 ? 12 : 0)), 0.1), 0.15);
    }
    // drums (never in the intro, never harsh)
    const drums = s !== 'intro' && !(s === 'break' && rel === 0), full = ['full', 'full-var', 'groove', 'peak'].includes(s) || (s === 'break' && rel === 2);
    for (let q = 0; q < 4 && drums; q++) {
        const tb = t0 + q * BEAT;
        if (full || q % 2 === 0) M(tb, 0.4, kick, full ? 0.5 : 0.36);
        if (full && (q === 1 || q === 3)) M(tb, 0.25, snap(), 0.13, 0.1);
        const nh = (s === 'peak' || (s === 'break' && rel === 2)) ? 4 : 2;
        for (let e = 0; e < nh; e++) M(tb + e * BEAT / nh + (nh === 2 ? BEAT / 4 * 0 : 0), 0.08, hat, (e % 2 ? 0.08 : 0.12) * (nh === 4 ? 0.75 : 1), 0.3 * (e % 2 ? 1 : -1));
    }
    // arp plucks
    if (s === 'intro') { if (b === 1) M(t0 + BEAT * 1.5, 0.6, pluck(hz(81), 0.2), 0.12, 0.25); if (b === 2) M(t0 + BEAT * 2.5, 0.6, pluck(hz(86), 0.2), 0.11, -0.25); }
    else if (s !== 'break' || rel >= 1) {
        const hooked = ['full', 'full-var', 'groove', 'peak'].includes(s), step = s === 'beat' ? 2 : 1, oct = hooked ? 12 : 24;
        const g = s === 'beat' ? 0.075 : s === 'peak' ? 0.085 : 0.07;
        for (let i = 0; i < 16; i += step) { if (s === 'break' && rel === 1 && i % 2) continue; M(t0 + i * BEAT / 4, 0.45, pluck(hz(c[[0, 1, 2, 3, 2, 1][i % 6]] + oct), 0.1), g, Math.sin(i * 1.7) * 0.45); }
    }
    // hooks and bells
    const hk = (['full', 'groove'].includes(s) ? HOOK_A : ['full-var', 'peak'].includes(s) ? HOOK_B : null);
    if (hk) hk[b % 4].forEach((n, i) => { if (n === null) return; M(t0 + i * BEAT / 2, 0.6, pluck(hz(n), 0.25), s === 'peak' ? 0.19 : 0.17, 0.2); if (s === 'peak' || s === 'groove') M(t0 + i * BEAT / 2, 2, bell(hz(n + 12), 1.8), 0.035, -0.35); });
    if (['full', 'full-var'].includes(s) && b % 2 === 0) M(t0, 2.4, bell(hz(c[2] + 36), 2.2), 0.1, 0.4);    // a small bell on the first beat of every other bar
    if (s === 'break') for (const [k, off] of [[1, 0], [3, 1], [2, 2.5], [0, 3.5]]) M(t0 + off * BEAT, 2.4, bell(hz(c[k] + 36), 2.2), 0.1, k % 2 ? 0.4 : -0.4);   // glassy break
}
// the intro: a few soft bells floating above the pad
[[1.5, 93], [4.5, 98]].forEach(([t, n], i) => M(t, 3, bell(hz(n), 2.8), 0.06, i ? 0.4 : -0.4));
// the closing: one hit at 54 s (kick, round sub, a warm Dm add9 chord and a bell chord), then pad and bells that fade out
for (const n of [50, 57, 62, 65, 69, 74]) M(54, 6, padVoice(hz(n), 4.5), 0.2, (n % 5 - 2) * 0.2);
M(54, 0.6, kick, 0.8); M(54, 3, bass(hz(26), 2.2), 0.4);
for (const [i, n] of [93, 98, 101].entries()) M(54.02 + i * 0.03, 4, bell(hz(n), 3.5), 0.14, (i - 1) * 0.5);
[[55.5, 98, 0.12], [56.5, 93, 0.1], [57.5, 89, 0.08], [58.4, 86, 0.06]].forEach(([t, n, g]) => M(t, 3, bell(hz(n), 2.5), g, (n % 2) - 0.5));
// ---- SFX stem: a short riser 1 s before each section line and a soft hit on the line, plus the film's cues
const BOUND = [6, 14, 24, 32, 38, 46, 54];
const riser = (t0, g) => S(t0, 1, (() => { let a = 0, b = 0; return t => { const x = t, k1 = clamp((600 + 6000 * x * x) / SR * TAU, 0, 1), k2 = clamp(250 / SR * TAU, 0, 1); a += (rnd() - a) * k1; b += (a - b) * k2; return (a - b) * x ** 2 * Math.min(1, (1 - x) / 0.03) * g * 5; }; })(), 1, 0);
const hit = (t0, g) => S(t0, 1.4, t => (sine((46 + 40 * Math.exp(-t * 20)) * t) * 0.9 + sine(300 * t) * 0.1 * Math.exp(-t * 30)) * Math.exp(-t * 3.2) * Math.min(1, t / 0.003) * g, 1, 0);
const shimmer = (t0, n, g) => S(t0, 1.8, bell(hz(n), 1.6), g, 0.2);
BOUND.forEach((t, i) => { riser(t - 1, i === 6 ? 0.2 : 0.14); hit(t, i === 6 ? 0.55 : 0.34); shimmer(t, 93 + (i % 3) * 3, i === 6 ? 0.12 : 0.07); });
const pop = (t0, note, g = 0.34) => S(t0, 0.35, t => { const f = hz(note), ph = f * (t + 0.5 * (t - (1 - Math.exp(-40 * t)) / 40)); return (sine(ph) + 0.25 * sine(2 * ph)) * Math.exp(-t * 15) * Math.min(1, t / 0.002) * g; }, 1, 0);
const click = (t0, f, g = 0.17) => S(t0, 0.08, t => (sine(f * t) * Math.exp(-t * 70) + rnd() * Math.exp(-t * 400) * 0.3) * Math.min(1, t / 0.0005) * g, 1, 0);
const POPS = [[1, 81], [3, 86], [5, 89]], CLICKS = [9, 17, 27, 35, 41, 49];
POPS.forEach(([t, n]) => pop(t, n)); CLICKS.forEach((t, i) => click(t, 1700 + 120 * (i % 3)));
// ---- reverb on the music (Schroeder: 4 combs + 2 allpasses), a little on the sfx
function reverb(buf, mix) {
    const dl = [1557, 1617, 1491, 1422].map(d => new Float32Array(d)), pos = [0, 0, 0, 0], ap = [225, 556].map(d => new Float32Array(d)), ap2 = [0, 0];
    for (let i = 0; i < N; i++) {
        const x = buf[i]; let s = 0;
        for (let k = 0; k < 4; k++) { const y = dl[k][pos[k]]; dl[k][pos[k]] = x * 0.3 + y * 0.84; pos[k] = (pos[k] + 1) % dl[k].length; s += y; }
        for (let k = 0; k < 2; k++) { const y = ap[k][ap2[k]]; const z = s + 0.5 * y; ap[k][ap2[k]] = z * -0.5 + s; s = y - 0.5 * z; ap2[k] = (ap2[k] + 1) % ap[k].length; }
        buf[i] = x + s * mix * 0.25;
    }
}
reverb(L, 0.5); reverb(R, 0.5); reverb(SL, 0.28); reverb(SRr, 0.28);
// ---- the mix: fade in 20 ms, the closing fades from 55 s to silence at 60 s (cosine), plus a linear 0.4 s at the very end
const fade = i => { const t = i / SR; return Math.min(1, t / 0.02) * (t > 55 ? 0.5 * (1 + Math.cos(Math.PI * (t - 55) / 5)) : 1) * Math.min(1, (DUR - t) / 0.4); };
function wavBuf(l, r, g) {
    const b = Buffer.alloc(44 + N * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + N * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(N * 4, 40);
    for (let i = 0; i < N; i++) { const f = fade(i) * g; b.writeInt16LE(Math.round(clamp(Math.tanh(l[i] * f) * 0.98, -1, 1) * 32767), 44 + i * 4); b.writeInt16LE(Math.round(clamp(Math.tanh(r[i] * f) * 0.98, -1, 1) * 32767), 46 + i * 4); }
    return b;
}
const mixL = new Float32Array(N), mixR = new Float32Array(N); let peak = 0, mp = 0;
for (let i = 0; i < N; i++) { mixL[i] = L[i] * 0.55 + SL[i]; mixR[i] = R[i] * 0.55 + SRr[i]; peak = Math.max(peak, Math.abs(mixL[i]), Math.abs(mixR[i])); mp = Math.max(mp, Math.abs(L[i]), Math.abs(R[i])); }
writeFileSync(join(OUT, 'music.wav'), wavBuf(L, R, 0.85 / mp));
writeFileSync(join(OUT, 'sfx.wav'), wavBuf(SL, SRr, 1.0));
// ---- master: music + sfx, two-pass ffmpeg loudnorm to -16 LUFS, true peak <= -1 dBTP, 48 kHz stereo, padded/trimmed to exactly 60.0 s
const raw = wavBuf(mixL, mixR, 0.89 / peak * 0.9), TARGET = 'I=-16:TP=-1.5:LRA=11';
const ff = (args, input) => spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args], {input, maxBuffer: 1 << 28});
const p1 = ff(['-i', 'pipe:0', '-af', `loudnorm=${TARGET}:print_format=json`, '-f', 'null', '-'], raw), txt = p1.stderr.toString(), m = JSON.parse(txt.slice(txt.lastIndexOf('{'), txt.lastIndexOf('}') + 1));
const p2 = ff(['-i', 'pipe:0', '-af', `loudnorm=${TARGET}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=${SR},apad=whole_dur=${DUR}`, '-t', String(DUR), '-ar', String(SR), '-ac', '2', '-c:a', 'pcm_s16le', join(OUT, 'master.wav')], raw);
if (p2.status !== 0) throw new Error(p2.stderr.toString());
// ---- amplitude envelope of the music stem (RMS over 1/60 s windows, after the fades), 3600 values 0..1, and the cue sheet
const env60 = []; for (let f = 0; f < DUR * 60; f++) { let s = 0; const a = Math.floor(f / 60 * SR), n = Math.floor(SR / 60); for (let i = a; i < Math.min(N, a + n); i++) { const g = fade(i); s += (L[i] * L[i] + R[i] * R[i]) / 2 * g * g; } env60.push(Math.sqrt(s / n)); }
const mx = Math.max(...env60); writeFileSync(join(OUT, 'envelope.json'), JSON.stringify(env60.map(v => +(v / mx).toFixed(4))));
const sfx = [...BOUND.flatMap(t => [{t: t - 1, name: 'riser'}, {t, name: 'hit'}]), ...POPS.map(([t]) => ({t, name: 'pop'})), ...CLICKS.map(t => ({t, name: 'click'}))].sort((a, b) => a.t - b.t || (a.name === 'riser' ? -1 : 1));
writeFileSync(join(OUT, 'cues.json'), JSON.stringify({duration: DUR, bpm: BPM, beat: BEAT, bar: BAR, bars: 30, beats: Array.from({length: DUR * 2}, (_, i) => +(i * BEAT).toFixed(3)),
    sections: SECTIONS.map(([a, b, name]) => ({name, start: a * BAR, end: b * BAR})), boundaries: BOUND, sfx}, null, 1));
console.log(`music, sfx, master written (${DUR}s, ${SR} Hz stereo); mix peak ${peak.toFixed(2)}; loudnorm input ${m.input_i} LUFS`);
