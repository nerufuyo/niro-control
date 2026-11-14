// Analyses the supplied soundtrack: duration/rate, 60 fps band envelopes, spectral-flux onsets, tempo + beat grid, energy sections.
// usage: node analyze.mjs <track.mp3> <outdir>   (writes analysis-full.json; window choice happens in choose.mjs)
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const [src, outdir] = process.argv.slice(2), SR = 22050;
const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', src, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {maxBuffer: 1 << 29}).stdout;
const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), dur = x.length / SR;
const N = 1024, HOP = SR / 100 | 0 /*100 hz frames*/, win = Float32Array.from({length: N}, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / N));
const bins = N / 2, re = new Float32Array(N), im = new Float32Array(N);
function fft() { // in-place radix-2
  for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let l = 2; l <= N; l <<= 1) { const a = -2 * Math.PI / l; for (let i = 0; i < N; i += l) for (let k = 0; k < l / 2; k++) { const c = Math.cos(a * k), s = Math.sin(a * k), u = i + k, v = u + l / 2, tr = re[v] * c - im[v] * s, ti = re[v] * s + im[v] * c; re[v] = re[u] - tr; im[v] = im[u] - ti; re[u] += tr; im[u] += ti; } }
}
const frames = Math.floor((x.length - N) / HOP), flux = new Float32Array(frames), low = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames), rms = new Float32Array(frames);
let prev = new Float32Array(bins);
const hz = b => b * SR / N;
for (let f = 0; f < frames; f++) {
  let r = 0; for (let i = 0; i < N; i++) { const v = x[f * HOP + i]; re[i] = v * win[i]; im[i] = 0; r += v * v; } rms[f] = Math.sqrt(r / N); fft();
  let fl = 0, lo = 0, mi = 0, hi = 0; const cur = new Float32Array(bins);
  for (let b = 1; b < bins; b++) { const m = Math.hypot(re[b], im[b]); cur[b] = Math.log1p(m * 10); fl += Math.max(0, cur[b] - prev[b]); const h = hz(b); if (h < 200) lo += m; else if (h < 2500) mi += m; else hi += m; }
  flux[f] = fl; low[f] = lo; mid[f] = mi; high[f] = hi; prev = cur;
}
// onsets: peaks of flux above local mean + k*sd
const onsets = [], W = 20;
for (let f = W; f < frames - W; f++) { let m = 0, s = 0; for (let k = -W; k <= W; k++) m += flux[f + k]; m /= 2 * W + 1; for (let k = -W; k <= W; k++) s += (flux[f + k] - m) ** 2; s = Math.sqrt(s / (2 * W + 1)); if (flux[f] > m + 1.2 * s && flux[f] >= flux[f - 1] && flux[f] > flux[f + 1] && (!onsets.length || f / 100 - onsets.at(-1).t > 0.08)) onsets.push({t: +(f / 100).toFixed(3), s: +(flux[f] - m).toFixed(3)}); }
// tempo: autocorrelation of flux over 60..180 bpm
let best = {bpm: 0, v: -1}; for (let bpm = 60; bpm <= 180; bpm += 0.25) { const lag = 6000 / bpm; let v = 0, c = 0; for (let f = 0; f + lag < frames; f++) { const a = flux[f], b = flux[Math.round(f + lag)]; v += a * b; c++; } v /= c; if (v > best.v) best = {bpm, v}; }
// beat phase: offset maximising summed flux on the grid
const per = 60 / best.bpm; let ph = {o: 0, v: -1}; for (let o = 0; o < per; o += 0.005) { let v = 0; for (let t = o; t < dur - 1; t += per) v += flux[Math.round(t * 100)] ?? 0; if (v > ph.v) ph = {o, v}; }
const sec = n => Array.from({length: Math.floor(dur)}, (_, s) => { let a = 0; for (let f = s * 100; f < s * 100 + 100 && f < frames; f++) a += n[f]; return +(a / 100).toFixed(4); });
writeFileSync(`${outdir}/analysis-full.json`, JSON.stringify({file: src, duration: +dur.toFixed(3), sampleRate: SR, tempo: +best.bpm.toFixed(2), beatOffset: +ph.o.toFixed(3), beatPeriod: +per.toFixed(4), onsets, perSecond: {rms: sec(rms), low: sec(low), mid: sec(mid), high: sec(high)}, fps100: {rms: Array.from(rms, v => +v.toFixed(4)), low: Array.from(low, v => +v.toFixed(3)), mid: Array.from(mid, v => +v.toFixed(3)), high: Array.from(high, v => +v.toFixed(3)), flux: Array.from(flux, v => +v.toFixed(3))}}));
console.log({dur, tempo: best.bpm, beatOffset: ph.o, onsets: onsets.length});
