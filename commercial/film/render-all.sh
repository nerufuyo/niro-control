#!/bin/bash
# Renders both masters: chunks of 180 frames in parallel (frames are independent), then joins them. No frames are written to disk: each chunk streams into ffmpeg.
set -u
cd "$(dirname "$0")/.."
P=${P:-5}
for aspect in wide tall; do
  seq 0 180 2699 | xargs -P "$P" -I{} bash -c "node film/render.mjs $aspect {} \$(({}+180)) out/seg/${aspect}-\$(printf %04d {}).mp4 2>&1 | tail -1"
  ls out/seg/$aspect-*.mp4 | sed "s#^#file '$PWD/#; s#\$#'#" > out/seg/$aspect.txt
  ffmpeg -y -loglevel error -f concat -safe 0 -i out/seg/$aspect.txt -c copy out/video-$aspect-silent.mp4
done
echo rendered
