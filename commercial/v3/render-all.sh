#!/bin/bash
# V3 final renders (silent, high-quality H.264): 4K 16:9 then 1080x1920 9:16, 60 fps, 45.000 s
cd "$(dirname "$0")"
node scene/render.mjs wide 0 2700 out/video-wide-silent.mp4 16 && node scene/render.mjs tall 0 2700 out/video-tall-silent.mp4 16 && echo ALLDONE
