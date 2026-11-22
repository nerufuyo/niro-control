# Niro Control: the 60-second film (v5, real captures)

Every picture in this film is a **screenshot of Niro Control itself**, taken in a private headless GNOME Shell with the installed package
(Fedora 45, its own default wallpaper, English, Niro's default accent and glass). Nothing in the film is drawn to look like the product: the
island, Search, the dock, the windows, Tile and the panel are the real thing. What is added is marked below.

## What you see, and where it comes from
| Time | Scene | Source |
|---|---|---|
| 0-6 s | the desktop and one line of text | `desk` |
| 6-14 s | **Island**: the pill, then the pointer-free open (the controller's own `expand()`), the Music page | `isl-closed`, `isl-open-*` |
| 14-24 s | **Search**: the empty palette (its suggestions), `2*pi+17`, `10 km to mi`, `10:00 jakarta to london`, then `accent` typed | `s-*` |
| 24-32 s | **Dock**: icons magnifying under a moving pointer, with the tooltips; **blur and corners** on Calculator and Text Editor over the wallpaper | `dock-*`, `windows2` |
| 32-38 s | **Tile**: four real windows (two Files, Text Editor, Calculator) in Dwindle, Master left and Grid | `tile-*` |
| 38-46 s | **Profiles**: the real page, then "Active profile: Deep Work" after `profile.apply` was run | `panel-profiles*` |
| 46-54 s | **Flow**: the real page with a saved workflow ("Focus mode") and the templates | `flow-before` |
| 54-60 s | the end card (the mascot is the banner's, drawn in `film.html`) | drawn |

## What is added
Orange rings around what is being talked about, the camera moves, the captions, the layout name in the corner during Tile, the first line of text
and the end card. They sit on top of the screenshots and never replace anything in them.

## What the film does not show
* The music in the island is a **demo player** (`capture/fake-player.js`: "Glass Hours", Nightfall Collective): the island is real, the song is not.
* The Flow workflow was saved and run (its history says `ok`), but the film shows the page, not the run: a profile applied by Flow changes the desktop very little.
* Opening the island is done by calling the island's own `expand()`: in a headless session a virtual pointer never reaches the island (the Search entry sits on top of it there).
* Screenshots are stills: transitions between states are cross-fades, and the island's opening is five captured frames.

## Rebuild
```
ENV="LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LANGUAGE=en_US:en WALLPAPER_URI=file:///usr/share/backgrounds/f45/default/f45-01-night.jxl ACCENT=#E8472B TINT=#1C1C1E GLASS=80"
for i in 1 2 3; do env $ENV commercial/capture/session.sh commercial/capture/steps-film-$i.sh /tmp/niro-film/$i; done      # about 8 minutes, needs the package installed
python3 commercial/v5/prep-shots.py /tmp/niro-film/1 /tmp/niro-film/2 /tmp/niro-film/3
cd commercial/v5 && node audio/synth.mjs && P=5 ./render-all.sh          # -> out/niro-control-60s.mp4 (a minute or two)
node still.mjs 26.5 /tmp/a.png 44 /tmp/b.png                              # single frames, to look at the film without rendering it
```
The capture session is hermetic (its own HOME, settings and D-Bus). `capture/prepare.sh` was updated for GNOME 51: `Clutter.get_default_backend()` no longer
exists, so the virtual pointer and keyboard come from `global.stage.context.get_backend()`. Its first move lands at x=0 (the hot corner opens the Overview), so a move is
made first and the Overview closed.

## Credits
The wallpaper is Fedora 45's default (CC BY-SA), used only in the captures. The soundtrack is original (`audio/synth.mjs`, pure Node, 120 BPM, D minor): measured
(60.000 s, about -16 LUFS, no clipping) but not auditioned by ear. The built videos, the WAV files and the captures are not committed.
