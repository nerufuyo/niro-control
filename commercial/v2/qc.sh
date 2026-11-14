#!/bin/bash
# Quality control on the FINAL files: stream facts, loudness, and contact sheets taken from the rendered videos (not from the scene code).
cd "$(dirname "$0")"; mkdir -p reports/contact
for f in deliverables/*.mp4; do echo "== $f"; ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames,duration,sample_rate -of compact=p=0 "$f"; done
ffmpeg -hide_banner -i deliverables/NIRO-v2-3D-45s-4K-16x9-60fps.mp4 -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | tail -3
declare -A S=( [01-origin]="0 1 2 3 4.8" [02-island-born]="5 6 7 8 9.5" [03-music-hero]="10 11.5 13 15 16.8" [04-desktop]="17.3 18.6 20.4 21.5 23.5" [05-glass-world]="25 26.5 28 29.2 30.4" [06-search]="31.2 32 33.2 34 34.9" [07-personalise]="35.5 36.5 37.5 38.6 39.8" [08-final]="40.4 41.2 42 43.5 44.8" )
for a in 4K-16x9 1080x1920-9x16; do for k in "${!S[@]}"; do
  rm -rf /tmp/qc; mkdir -p /tmp/qc; i=0; for t in ${S[$k]}; do ffmpeg -y -loglevel error -ss $t -i deliverables/NIRO-v2-3D-45s-$a-60fps.mp4 -frames:v 1 -vf "scale=$([ $a = 4K-16x9 ] && echo 640:-1 || echo 270:-1)" /tmp/qc/$(printf %02d $i).png; i=$((i+1)); done
  ffmpeg -y -loglevel error -pattern_type glob -i "/tmp/qc/*.png" -vf "tile=5x1" -frames:v 1 reports/contact/$a-$k.png; done; done
ls reports/contact
