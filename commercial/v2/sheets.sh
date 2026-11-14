#!/bin/bash
# usage: sheets.sh <wide|tall> <outdir> <sheet.png> t...   (low-res camera / composition check)
a=$1; d=$2; o=$3; shift 3; rm -rf $d; cd "$(dirname "$0")" && node scene/preview.mjs $a 0.16 $d "$@" 2>&1 | tail -3
ffmpeg -y -loglevel error -pattern_type glob -i "$d/*.png" -vf "scale=480:-1,tile=6x$(( ($# + 5) / 6 ))" -frames:v 1 $o
