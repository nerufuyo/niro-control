# Music synchronisation report

Source: `Bleachers_-_Merry_Christmas_Please_Dont_Call_(mp3.pm).mp3` (202.15 s). Tempo estimate **110.25 BPM** (beat period 0.5442 s); the beat grid explains 18% of strong onsets, so events are snapped to the *detected onsets*, not to the grid.

**Excerpt used:** 91.544 s – 136.544 s of the track (45.000 s), chosen by an energy-arc score: quiet intro, rise at ~5 s (the chorus entering), loud hero section 10–17 s, strong end. Fade-in 0.5 s, fade-out 1.4 s.

| Film time (s) | Picture event | Nearest detected onset | Position in bar (grid estimate) |
|---|---|---|---|
| 0.996 | First glass appears (light beam passes) | 0.996 (0 ms, strength 84.1) | beat 1.83 of 4 |
| 5.016 | Glass capsule morphs into the Island | 5.016 (0 ms, strength 46.4) | beat 1.22 of 4 |
| 10.386 | Click on Play | 10.386 (0 ms, strength 226.4) | beat 3.08 of 4 |
| 10.656 | (spec marker) Island expansion window | 10.656 (0 ms, strength 67.4) | beat 3.58 of 4 |
| 11.206 | Waveform wakes inside the Island | 11.206 (0 ms, strength 84.3) | beat 0.59 of 4 |
| 17.026 | Camera passes through the Island glass | 17.026 (0 ms, strength 70.9) | beat 3.29 of 4 |
| 18.446 | Dock rises | 18.446 (0 ms, strength 196.2) | beat 1.90 of 4 |
| 20.596 | App launches from the dock | 20.596 (0 ms, strength 146.4) | beat 1.85 of 4 |
| 24.886 | Glass World: light sweeps the windows | 24.886 (0 ms, strength 181.4) | beat 1.73 of 4 |
| 31.066 | Search opens (Super+Space) | 31.066 (0 ms, strength 137.2) | beat 1.09 of 4 |
| 33.346 | Search result (calculation) | 33.346 (0 ms, strength 37.3) | beat 1.28 of 4 |
| 35.356 | Appearance changes (light wave) | 35.356 (0 ms, strength 141.2) | beat 0.97 of 4 |
| 38.316 | Profile switch (Deep Work) | 38.316 (0 ms, strength 91.9) | beat 2.41 of 4 |
| 40.996 | NIRO. logo reveal | 40.996 (0 ms, strength 69.3) | beat 3.33 of 4 |

Phrase markers (2-bar phrases, film time): 0.00, 4.35, 8.71, 13.06, 17.41, 21.77, 26.12, 30.48, 34.83, 39.18, 43.54
Energy peaks (film time): 1.5, 2.75, 5.5, 7.5, 9.5, 10.75, 14, 17.25, 18.25, 23.5, 26.75, 28.75, 33.75, 34.75, 35.25, 37, 43.75
Detected onsets in the excerpt: 191; the waveform in the Island is drawn from the 60 fps amplitude envelope (`envelope60`), the low band (`low60`) and spectral flux (`flux60`) in `analysis.json`.

Limits: tempo/beat grid come from autocorrelation of spectral flux and have not been checked by ear; the audio has not been listened to by the author of this report.
