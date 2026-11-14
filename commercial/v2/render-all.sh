#!/bin/bash
# Renders both masters (silent, high-quality H.264) from the WebGL scene. ~0.4 s/frame at 4K on a GTX 1050 Ti.
cd "$(dirname "$0")"
node scene/render.mjs wide 0 2700 out/video-wide-silent.mp4 17 && node scene/render.mjs tall 0 2700 out/video-tall-silent.mp4 17 && echo ALLDONE
