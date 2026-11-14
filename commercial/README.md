# NIRO — 45-second commercial

An original 45-second launch film for NIRO, built from **real captures of NIRO running in a private headless GNOME Shell** (Island, Dock, Search, NIRO Control, the GTK integration on real GTK 4 apps) composed with motion graphics. Nothing here is shipped with the product.

## What is real, what is cinematic

| Real (captured, unedited pixels) | Composed for the film |
|---|---|
| The Island pill and the expanded Music page (album, title, artist, controls, progress), paused and playing | The opening glass object and the morph into the pill |
| The Dock and its magnification, with tooltips | The pointer, its clicks and the press rings |
| Real GNOME Files and Text Editor with NIRO's GTK integration | The window-opening reveal from the dock icon, the light sweep over the windows |
| NIRO Search with an app query, a calculation (`2*pi+17`) and a settings query | The Super + Space key caps |
| NIRO Control: Look (accent, glass opacity, a preset) and Profiles (the Apply dialog and the toast) | The camera moves, titles, the glass slab and the logo |
| | The audio-reactive waveform (drawn from the soundtrack's own amplitude envelope; NIRO's Island has no waveform of its own beyond its small bars) |

The accent and tint colours in the captures are set to the film's palette (violet and ice blue); the built-in profiles in the film's session carry those colours instead of NIRO's ember red (a copy of the profile files, the shipped ones are untouched). Features shown are ones verified in a headless shell; no third-party application transparency is shown. The Island's "No lyrics for this song" panel is covered by the waveform card in the wide cut.

## Soundtrack and licensing

The requested track ("Merry Christmas, Please Don't Call" by Bleachers) is **not used and not included**: no licence is held and nothing was downloaded. `audio/synth.mjs` writes an **original temporary soundtrack** (45 s, 120 BPM, every scene change on a bar line) as separate stems (`music.wav`, `sfx.wav`, `master.wav`) with `cues.json` (beat grid and scene cues) and `envelope.json` (the music's amplitude at 60 per second, which drives the waveform). To use the licensed recording, secure the sync licence, cut the 45 s refrain, and re-time the cues in `film/film.html` (`CUR`, the `xf(...)` times) to its beats; the film is built around the cue sheet, not the temporary track.

## Rebuild

```
node audio/synth.mjs                      # stems, envelope, cues
capture/session.sh capture/steps-*.sh <outdir>   # the real captures (needs the installed niro-control package)
node film/preview.mjs wide <dir> 10.8 …   # stills of chosen times
film/render-all.sh                        # 4K 16:9 and 1080x1920 9:16 at 60 fps (frames stream to ffmpeg, none are stored)
```
The capture session is hermetic (own HOME, XDG folders and key-file settings; it refuses to run otherwise). The built video files are not committed.
