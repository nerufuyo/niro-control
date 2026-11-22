# Niro Control: the 60-second film (v4)

A 60 s, 1920x1080, 30 fps film with an original soundtrack. One deterministic HTML page (`film.html`, `window.__render(t)` draws the frame at `t`
seconds) is rendered frame by frame with headless Chrome and streamed into ffmpeg. No GPU, no 3D engine, no captures to redo: about a minute
of rendering.

## Rebuild
```
node audio/synth.mjs        # music.wav, sfx.wav, master.wav (-16 LUFS), envelope.json, cues.json   (about 6 s)
P=6 ./render-all.sh         # out/niro-control-60s.mp4  (the built videos are not committed)
node still.mjs 18.5 /tmp/f.png 42 /tmp/g.png     # single frames, to look at the film without rendering it
```
Needs Node 22 or newer, Google Chrome, ffmpeg. Fonts and pictures are read from `data/fonts` and `docs/images` of this repository.

## What is real and what is drawn
| Scene | Source |
|---|---|
| 0-6 s intro | the slime (drawn in `film.html`, the same dome as the banner) and two lines of text |
| 6-14 s **Island** | **illustration**: the island's states (clock, music, focus timer) drawn in HTML; the track and its artist are made up |
| 14-24 s **Search** | **real picture**: `docs/images/search-calculator.png` (the palette answering `2*pi+17`); the two key caps and the example queries (taken from the README) are drawn on top |
| 24-32 s **Dock** | **real picture**: the dock at the bottom of the same screenshot, zoomed |
| 32-38 s **Tile** | **illustration**: four windows moving between three layouts; no capture of Tile was used |
| 38-46 s **Profiles** | **real picture**: `docs/images/panel-home.png`; the glow around the four profile chips is drawn on top |
| 46-54 s **Flow** | **illustration**: a workflow (when an app opens, then Do Not Disturb, then a profile) and a check mark; nothing here was run |
| 54-60 s end | slime, name, one line, address and licence |

Scenes marked illustration carry an "ILLUSTRATION" label on screen. The real pictures are screenshots, so they are soft when zoomed; the
camera is held to a modest zoom for that reason. The screenshots are older than 1.6.0: they show neither Flow, Permissions nor Backup.

## Soundtrack
`audio/synth.mjs` writes an **original** 60 s track (120 BPM, D minor, every section change on a bar line) and its sound effects in pure Node.
It is not a licensed recording and none was downloaded. The numbers were checked (60.000 s, about -16 LUFS, no clipping); it has not been
auditioned by ear. `audio/cues.json` holds the beat grid and the cue times the film was timed to (section changes at 6, 14, 24, 32, 38, 46, 54 s).
