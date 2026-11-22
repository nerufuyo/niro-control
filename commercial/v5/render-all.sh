#!/bin/bash
# Renders the 60 s film at 1920x1080, 30 fps from the real captures in shots/ (chunks of 300 frames in parallel), joins them and muxes the
# soundtrack (audio/master.wav; build it with `node audio/synth.mjs`). usage: P=6 ./render-all.sh  -> out/niro-control-60s.mp4
set -euo pipefail
cd "$(dirname "$0")"
[ -f audio/master.wav ] || { echo "build the soundtrack first: node audio/synth.mjs"; exit 1; }
mkdir -p out/seg; rm -f out/seg/*
P=${P:-4}
seq 0 300 1799 | xargs -P "$P" -I{} bash -c 'node render.mjs {} $(({}+300)) out/seg/$(printf %04d {}).mp4 30 2>&1 | tail -1'
ls out/seg/*.mp4 | sed "s#^#file '$PWD/#; s#\$#'#" > out/seg/list.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i out/seg/list.txt -c copy out/video-silent.mp4
ffmpeg -y -loglevel error -i out/video-silent.mp4 -i audio/master.wav -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart out/niro-control-60s.mp4
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of default=nw=1 out/niro-control-60s.mp4
