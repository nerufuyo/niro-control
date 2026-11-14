#!/bin/bash
# Joins the silent masters with the mixed soundtrack (music excerpt + sparse SFX, -16 LUFS): MASTER (render copied, 320k AAC) and a distribution encode.
cd "$(dirname "$0")"; mkdir -p deliverables
for a in wide tall; do
  N=$([ $a = wide ] && echo "NIRO-V3-It-Just-Flows-4K-16x9-60fps" || echo "NIRO-V3-It-Just-Flows-1080x1920-9x16-60fps")
  ffmpeg -y -loglevel error -i out/video-$a-silent.mp4 -i audio/master-audio.wav -c:v copy -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest deliverables/$N-MASTER.mp4
  ffmpeg -y -loglevel error -i out/video-$a-silent.mp4 -i audio/master-audio.wav -c:v libx264 -preset slow -crf 19 -maxrate 40M -bufsize 80M -pix_fmt yuv420p -c:a aac -b:a 256k -ar 48000 -movflags +faststart -shortest deliverables/$N.mp4
done
ls -la deliverables
