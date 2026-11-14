# NIRO — It Just Flows · Quality-control report (V3)

**What was inspected:** the rendered files (not the scene code): per-shot contact sheets (`reports/contact/wide-*.png`, `tall-*.png`), sync proof strips (`reports/sync/*.png`, five frames at −0.10/−0.05/0/+0.05/+0.10 s around an event), full-resolution crops of S03, S04, S09 and the S11 hero, and the low-resolution animatics that preceded the final render. **What was not done:** the film was not watched in real time, and the audio was not listened to (levels and onset timing are measurements).

## Technical facts (ffprobe / ebur128)
| File | Video | Audio |
|---|---|---|
| `NIRO-V3-It-Just-Flows-4K-16x9-60fps(-MASTER).mp4` | H.264, 3840×2160, 60 fps, 2700 frames, 45.000 s | AAC 48 kHz stereo, 45.000 s |
| `NIRO-V3-It-Just-Flows-1080x1920-9x16-60fps(-MASTER).mp4` | H.264, 1080×1920, 60 fps, 2700 frames, 45.000 s | same |
Loudness −15.3 LUFS integrated, LRA 2.4 LU, true peak −2.7 dBFS. Audio and video are both exactly 45.000 s; the music excerpt is 28.5–73.5 s of the supplied track with a 0.3 s fade-in and a 1.3 s fade-out.

## Synchronisation (measured, see `docs/sync-map.md`)
Every event sits on a detected onset (0 ms from the onset for all but four events that were moved ≤ 0.29 s to the nearest strong one). In the rendered frames: the pause icon and the visualiser react on the 9.81 s frame (Play), the accent ring starts on the 35.59 s frame (accent click), the cut to NIRO. is on 42.03 s. The tempo grid is not trusted (it explains 18 % of strong onsets), so no event relies on it.

## The seven questions, shot by shot
| Shot | 1 Look at | 2 Why now | 3 What changes | 4 Understood afterwards | 5 Camera | 6 Transition | 7 UI readable |
|---|---|---|---|---|---|---|---|
| S01 | glass edge + light sweep | opens in near-darkness on the quiet verse | one sweep crosses the bevel | a precise glass material | micro-drift helps (depth) | fade-in → hard cut on an onset | n/a |
| S02 | the Island's glass body | first reveal of the shape | camera arcs 28° | the Island is a physical capsule | arc helps (shape) | hard cut on 5.71 s | n/a |
| S03 | the pill | rest before the interaction | nothing (held) | the real, calm product | locked | cut to the cursor entering | yes (clock, album) at ~2× upscale of a 164-pt pill |
| S04 | the Island | the first cause and effect | pill → player, Play, music answers | Play wakes the Island and the music | locked (the interface moves) | cut → camera move starts on a phrase | yes |
| S05 | the Island, then the desktop | the world is revealed | pull-back, Dock rises, Island closes | this is a real desktop | the one deliberate move | cut on 17.20 s | yes, then small by design |
| S06 | the Dock | next action | pointer, magnification, click, running dot | one click opens an app | slow drift, low 3/4 | match cut to the window | yes (icons) |
| S07 | Files, then the editor | the workflow | select, double-click, editor opens | opening a file opens an editor | locked | cut on 24.83 s | yes |
| S08 | the Dock's glass | the material the film is about | Files slides under the Dock and back | the Dock is real glass | slow 5° slide | cut on 28.34 s | n/a (no text) — **weak**, see below |
| S09 | the Search palette | the shortcut | keycaps, "a" → "acc" → "accent", result, Enter | one shortcut finds a setting | 7 % push | cut on 32.90 s | yes, labels truncated by NIRO itself ("Accent col…") |
| S10 | the Control Panel, the swatch | the payoff | click on Ember, a ring of light, every glass surface turns to the ember capture, "Make it yours." | one choice changes the desktop | locked | cut on 37.73 s | yes at 4K (small at 9:16, cropped there) |
| S11 | the finished desktop | rest | nothing | this is the result | locked (2 % drift) | cut on 42.03 s | yes |
| S12 | NIRO. | brand | letters settle, tagline | the name | locked | fade to black | yes |

## Known weaknesses (not hidden)
* **Glass is the least convincing claim.** In this capture NIRO's GTK windows (Files, Control Panel, Editor) are almost opaque (alpha ≈ 0.98 even with lower glass settings), so only the Dock (≈ 0.6) and the Search palette (≈ 0.7) are genuinely translucent. S08 therefore shows the Dock over a sliding window, and translucency over *other windows* is not blurred (the glass samples the wallpaper), which is why the windows behind the palette are dimmed.
* S01 and S02 are screen-space-refraction glass, not path-traced; S01 reads as a pane edge more than a product.
* S03 upsamples the pill about 2×; S05's last frame is an almost empty desktop by design.
* A faint blue fringe on some white UI edges (alpha-matting residue); the elapsed/remaining times and the pill clock are patched from one capture so they do not jump (documented in the README).
* Windows in the Accent B (ember) look do not change colour (the GTK selection stays the system orange); only the Island, Dock, Control Panel and the lighting do.
* The Island's right half is composed (the demo track has no lyrics): the visualiser is a compositing element, not a NIRO feature.
* Portrait: S10 is a crop (preview + swatches), S11 and S07 stack the two windows; the Dock is out of frame in S10.
* Search palette labels are truncated by NIRO's own narrow palette width.

## Rights
The soundtrack is "Merry Christmas, Please Don't Call" by Bleachers, supplied by the user. Public release needs sync and master-use licences; the files here are for review and are not in git.
