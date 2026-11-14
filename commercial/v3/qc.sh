#!/bin/bash
# QC on the FINAL files: stream facts, loudness, per-shot contact sheets, sync proof strips (frames around the Play press, the accent click and the logo cut)
cd "$(dirname "$0")"; mkdir -p reports/contact reports/sync
W=deliverables/NIRO-V3-It-Just-Flows-4K-16x9-60fps.mp4; T=deliverables/NIRO-V3-It-Just-Flows-1080x1920-9x16-60fps.mp4
for f in $W $T deliverables/*MASTER.mp4; do echo "== $f"; ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames,duration,sample_rate -of compact=p=0 "$f"; done
ffmpeg -hide_banner -i $W -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I|LRA|Peak):" | tail -3
python3 tools/contact.py $W reports/contact/wide; python3 tools/contact.py $T reports/contact/tall tall
for ev in play accent cut-s12 pill-click launch editor-open; do
  t=$(node -e "console.log(JSON.parse(require('fs').readFileSync('audio/sync.json')).events['$ev'])")
  for d in -0.1 -0.05 0 0.05 0.1; do ffmpeg -y -loglevel error -ss $(python3 -c "print(max(0,$t+($d)))") -i $W -frames:v 1 -vf scale=480:-1 /tmp/sync-$ev-$d.png; done
  ffmpeg -y -loglevel error $(for d in -0.1 -0.05 0 0.05 0.1; do echo -i /tmp/sync-$ev-$d.png; done) -filter_complex hstack=5 reports/sync/$ev.png
done; ls reports/contact reports/sync
