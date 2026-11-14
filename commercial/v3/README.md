# NIRO — It Just Flows (V3, director-led)

A grounded 2.5D desktop film. Every NIRO element on screen is a **real capture** from a private headless GNOME session; its true translucency is recovered from a black/white capture pair and the element is then composited over the film's own wallpaper in a three.js scene, shot by shot. Physical 3D glass is used only where a material has to be shown (the two opening macros and the logotype).

Documents: `docs/treatment.md` (idea, why V2 failed, rules), `docs/shotlist.md` (12 shots with camera parameters), `docs/sync-map.md` (events ↔ measured onsets), `reports/qc-report.md` (what was checked and what was not), `reports/contact/` and `reports/sync/` (stills from the final videos).

## Rebuild
```
# 1. plates (one private session at a time; see ../capture/steps-v3*.sh; accents A=violet, B=ember)
cd .. && for a in A B ...   # see /capture/steps-v3.sh, steps-v3w.sh (windows, one per session), steps-v3x.sh (typing states)
# 2. recover alpha from each black/white pair and crop
cd v3 && node tools/matte.mjs A && node tools/matte.mjs B       # -> tex/<name>-<A|B>.png + plates-*.json
node tools/mkwall.mjs                                            # the film wallpaper (tools/wallpaper.html)
node scene/mklogo.mjs                                            # NIRO. outline from Inter
# 3. music: analysis, excerpt choice, sync map, sound design, mix
node audio/analyze.mjs <track.mp3> audio && node audio/pick.mjs && node audio/sync.mjs && node audio/sfx.mjs
ffmpeg -ss 28.5 -t 45 -i <track.mp3> ... audio/music-excerpt.wav ; amix with sfx.wav, loudnorm -16 -> audio/master-audio.wav
# 4. review: node scene/animatic.mjs <wide|tall> 0.2 15 out/animatic.mp4 ; python3 tools/contact.py <video> /tmp/sheet
# 5. final
./render-all.sh && ./mux.sh && ./qc.sh
```

## What is real, what is composed
| Element | Source |
|---|---|
| Island pill, open player, Dock (idle, Files running, two apps running), Files, Text Editor, Search palette (empty, "a", "acc", "accent"), Control Panel Look page (violet and ember) | real captures; alpha recovered exactly from a black/white pair |
| Pill clock | digits taken from the violet capture in both looks (the two captures were taken minutes apart) |
| Island's right half | the real "No lyrics" placeholder (the demo track has none) is replaced by the player's own gradient and the visualiser is drawn there from the supplied track's amplitude (composed, not a NIRO feature) |
| Cursor, keycaps (Super, Space), "Make it yours.", logotype, tagline, wallpaper, the ember ring and glow | composed |
| Magnified dock icons, window open/settle animation | a UV lens on the capture and a scale/fade, standing in for the shell's own animation |
| Opening glass | physical glass (three.js MeshPhysicalMaterial), screen-space refraction, a procedural softbox environment |

Not claimed: GTK windows in this capture are ~opaque (alpha 0.98), so only the Dock (≈0.6) and the Search palette (≈0.7) are shown as glass. Translucency over *other windows* is not blurred (the glass samples the wallpaper), which is why windows behind the palette are dimmed.
