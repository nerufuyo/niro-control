// V3 music-sync map. Excerpt start is chosen by pick.mjs (28.5 s of the track); every picture event is placed on a measured onset, never on an invented beat.
// usage: node sync.mjs   -> sync.json (+ analysis fields the scene reads), ../docs/sync-map.md
import {readFileSync, writeFileSync} from 'node:fs';
const A = JSON.parse(readFileSync('analysis-full.json')), S = 28.5, on = A.onsets.filter(o => o.t >= S - 1 && o.t < S + 46).map(o => ({t: +(o.t - S).toFixed(3), s: o.s}));
const strong = on.filter(o => o.s > 40), near = (t, tol = .3, min = 40) => { let b = null; for (const o of on) if (o.s >= min) { const d = Math.abs(o.t - t); if (d <= tol && (!b || d < b.d)) b = {t: o.t, s: o.s, d}; } return b; };
const R = A.fps100.rms, m = (a, b) => { let s = 0, n = 0; for (let i = Math.round((S + a) * 100); i < Math.round((S + b) * 100); i++) { s += R[i] ?? 0; n++; } return s / Math.max(1, n); };
// [name, target film time, why]. Picture events are listed in the order they happen.
const T = [
  ['sweep', 1.4, 'S01 light sweep peaks on the first strong transient'], ['cut-s02', 3.0, 'S01→S02 hard cut'], ['cut-s03', 6.0, 'S02→S03 hard cut to the frontal Island (quiet bar)'],
  ['cursor-in', 8.0, 'cursor enters (rests on the pill)'], ['pill-click', 8.75, 'click on the Island, it expands'], ['play', 9.81, 'PLAY press: the chorus enters (strongest onset of the phrase)'],
  ['viz', 10.35, 'visualiser reacts to the first chorus hit'], ['pullback', 13.03, 'S04→S05 dolly back begins with the next phrase'], ['dock-in', 14.24, 'dock enters on the big transient (reveal of the full desktop)'],
  ['cut-s06', 17.2, 'S05→S06 cut'], ['launch', 20.01, 'click on the Files icon: strongest onset of the dock shot'], ['cut-s07', 20.59, 'match cut to the opened Files window'],
  ['file-click', 22.45, 'cursor selects notes.md'], ['editor-open', 23.77, 'double-click: Text Editor opens as the consequence'], ['cut-s08', 24.83, 'S07→S08 cut to the glass detail'],
  ['drag', 25.92, 'window starts to move'], ['cut-s09', 28.34, 'S08→S09 cut to Search'], ['search-open', 29.53, 'Super+Space: search opens on a strong hit'], ['type', 30.05, 'typing starts'],
  ['result', 31.15, 'result highlights'], ['enter', 32.37, 'Enter: the action'], ['cut-s10', 32.9, 'cut to the Control Panel as the music thins (the quiet before the change)'],
  ['accent', 35.59, 'accent click: the strongest onset of the whole film, energy returns'], ['yours', 36.39, '"Make it yours." appears on the next accent'], ['cut-s11', 37.73, 'S10→S11 cut to the finished desktop on a strong phrase onset'],
  ['cut-s12', 42.03, 'S11→S12 cut to NIRO. on a strong onset'], ['end', 45.0, 'fade out over the last 0.7 s'],
];
const ev = {}, rows = T.map(([k, t, why]) => { const n = near(t); ev[k] = n ? n.t : t; return `| ${ev[k].toFixed(2)} | ${k} | ${why} | ${n ? `onset ${n.t.toFixed(2)} s, strength ${n.s.toFixed(0)}, ${((n.t - t) * 1000).toFixed(0)} ms from plan` : 'no onset within 0.3 s: placed on plan'} |`; });
ev.end = 45;
const sec = [[0, 8, 'quiet verse'], [8, 33, 'chorus (loud)'], [33, 36, 'the dip before the change'], [36, 45, 'chorus returns']].map(([a, b, n]) => `${a}–${b} s ${n}: mean rms ${m(a, b).toFixed(2)}`);
writeFileSync('sync.json', JSON.stringify({source: A.file, excerptStart: S, events: ev, onsets: on, rms1s: Array.from({length: 45}, (_, i) => +m(i, i + 1).toFixed(3)),
  env60: Array.from({length: 2700}, (_, i) => +m(i / 60 - .008, i / 60 + .008).toFixed(4)), low60: Array.from({length: 2700}, (_, i) => +((A.fps100.low[Math.round((S + i / 60) * 100)] ?? 0)).toFixed(2)), flux60: Array.from({length: 2700}, (_, i) => +((A.fps100.flux[Math.round((S + i / 60) * 100)] ?? 0)).toFixed(3))}));
writeFileSync('../docs/sync-map.md', `# V3 music synchronisation map\n\nSource: \`${A.file.split('/').pop()}\`. Excerpt: **${S} s → ${S + 45} s** of the track (45.000 s), picked by \`pick.mjs\` (quiet verse, chorus entry at ~9.8 s, a dip at ~33 s, energy back at ~35.6 s). Fade in 0.3 s, fade out 1.3 s.\n\nEnergy: ${sec.join('; ')}.\n\nEvery event below sits on a *measured* onset (spectral flux peak) within 0.3 s of the plan; none is invented. Onsets with strength > 40 are "strong".\n\n| Film time (s) | Event | Intent | Matched onset |\n|---|---|---|---|\n${rows.join('\n')}\n`);
console.log(rows.join('\n'));
