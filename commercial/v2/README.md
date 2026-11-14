# NIRO 45 s launch film, v2 — real 3D pipeline

A three.js scene (real geometry, physically based glass, image-based lighting, one continuous virtual camera) rendered frame by frame in headless Chrome on the GPU (WebGL2) and piped into ffmpeg. The UI on every surface is a **real capture** of NIRO (`../capture/steps-*.sh`, hermetic private GNOME sessions).

Blender / Cycles were not available in this environment (no `bpy`, no Blender; a GTX 1050 Ti could not path-trace 2 × 2700 frames anyway). three.js is the genuine-3D route that fits: `MeshPhysicalMaterial` transmission, ior 1.5, dispersion, clearcoat, bevelled extruded slabs, PMREM environment, bloom, depth of field, MSAA. Nothing is a CSS transform of a screenshot.

## Rebuild
```
npm install                                   # three, opentype.js
node audio/analyze.mjs <track.mp3> audio      # full-track analysis      -> audio/analysis-full.json
node audio/choose.mjs                         # 45 s excerpt + sync map  -> audio/analysis.json
node audio/report.mjs                         # reports/sync-report.md
node audio/sfx.mjs                            # subtle SFX stem          -> audio/sfx.wav
# music excerpt + mix: see mux section in the commands used (ffmpeg -ss <excerptStart> -t 45 ... ; loudnorm -16 LUFS)
node scene/mklogo.mjs                         # NIRO. outline from Inter
./render-all.sh                               # ~0.45 s/frame at 4K (≈20 min) + ≈6 min portrait
./mux.sh && ./qc.sh
node scene/preview.mjs wide 0.25 /tmp/pv 5 10 17   # stills; ./sheets.sh <aspect> <dir> <sheet.png> t…
```
UI plates: `tex/*.png` are crops of the captures (`../assets/shots`, `../assets/shots2` — not in git; re-create with `capture/session.sh capture/steps-v2.sh assets/shots2`).

## What is real and what is composed
| Element | Source |
|---|---|
| Island pill, open Island, Dock, Files, Text Editor, Search palette (open / fire / calculator / setting), Control Panel (Look page with live preview, Profiles page, apply dialog) | real captures, textured onto slabs; content not edited, except below |
| Island in the music hero | the real open-Island capture with its "No lyrics" panel **removed** (replaced by the body gradient) and a visualiser card placed in that spot. The card is a compositing enhancement, not a NIRO feature |
| Waveform | drawn from the soundtrack's own 60 fps envelope, low band and spectral flux |
| Glass capsule, camera, lights, light beam, rim light, dust, NIRO. logotype (Inter, extruded), tagline | composed |
| Accent / glass change on the Control Panel | real captures (violet → icy blue accent, opacity 70 → 55 %) |
| "Environment turns violet" | lighting/wallpaper tint only. **Island, Dock and Search UI are not recoloured** (no captures with other accents exist) |
| Deep Work "layout change" | dock slides away (the profile's description is "a hidden dock, quiet alerts"); the Control Panel shows the real apply dialog; the post-apply banner state is never shown |
| Magnified dock icons | UV lens on the capture, not NIRO's own animation |

## Known limits (honest list)
* Not path-traced: refraction is three.js's screen-space transmission; reflections come from a procedural softbox environment.
* The glass capsule reads a little boxy at some angles; the logo is lit glass with an emissive core rather than a pure refractive object.
* Search palette states cross-fade (brief double exposure of the old and new text).
* 30.4 s: a short, almost empty frame while the camera turns from the windows to the Search glass.
* Beat grid fits only ~18 % of strong onsets; events are snapped to detected onsets. Music was **analysed, not auditioned**.
* Portrait is a separate camera path and a separate Island layout (player + visualiser stacked, the status cluster of the real Island omitted), not a crop.
