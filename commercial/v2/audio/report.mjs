// Music synchronisation report: for every picture event, the time, the nearest detected onset and how strong it is, and where it sits in the bar.
import {readFileSync, writeFileSync} from 'node:fs';
const A = JSON.parse(readFileSync('audio/analysis.json')), on = A.onsets, per = A.beatPeriod;
const near = t => on.reduce((b, o) => Math.abs(o.t - t) < Math.abs(b.t - t) ? o : b, on[0]);
const labels = {glassAppear: 'First glass appears (light beam passes)', islandBirth: 'Glass capsule morphs into the Island', playClick: 'Click on Play', islandExpand: '(spec marker) Island expansion window', wavesStart: 'Waveform wakes inside the Island', passThrough: 'Camera passes through the Island glass', dockRise: 'Dock rises', appLaunch: 'App launches from the dock', glassWorld: 'Glass World: light sweeps the windows', searchOpen: 'Search opens (Super+Space)', searchResult: 'Search result (calculation)', appearanceShift: 'Appearance changes (light wave)', profileSwitch: 'Profile switch (Deep Work)', logoReveal: 'NIRO. logo reveal'};
const rows = Object.entries(A.events).map(([k, t]) => { const o = near(t), bar = ((t / per) % 4); return `| ${t.toFixed(3)} | ${labels[k] ?? k} | ${o.t.toFixed(3)} (${((o.t - t) * 1000).toFixed(0)} ms, strength ${o.s.toFixed(1)}) | beat ${bar.toFixed(2)} of 4 |`; });
const md = `# Music synchronisation report

Source: \`${A.source.split('/').pop()}\` (${A.fullDuration.toFixed(2)} s). Tempo estimate **${A.tempo} BPM** (beat period ${A.beatPeriod} s); the beat grid explains ${(A.gridFit * 100).toFixed(0)}% of strong onsets, so events are snapped to the *detected onsets*, not to the grid.

**Excerpt used:** ${A.excerptStart.toFixed(3)} s – ${A.excerptEnd.toFixed(3)} s of the track (45.000 s), chosen by an energy-arc score: quiet intro, rise at ~5 s (the chorus entering), loud hero section 10–17 s, strong end. Fade-in 0.5 s, fade-out 1.4 s.

| Film time (s) | Picture event | Nearest detected onset | Position in bar (grid estimate) |
|---|---|---|---|
${rows.join('\n')}

Phrase markers (2-bar phrases, film time): ${A.phrases.map(p => p.toFixed(2)).join(', ')}
Energy peaks (film time): ${A.energyPeaks.join(', ')}
Detected onsets in the excerpt: ${A.onsets.length}; the waveform in the Island is drawn from the 60 fps amplitude envelope (\`envelope60\`), the low band (\`low60\`) and spectral flux (\`flux60\`) in \`analysis.json\`.

Limits: tempo/beat grid come from autocorrelation of spectral flux and have not been checked by ear; the audio has not been listened to by the author of this report.
`;
writeFileSync('reports/sync-report.md', md); console.log(md.split('\n').slice(0, 24).join('\n'));
