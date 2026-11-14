#!/bin/bash
# usage: sheet.sh <dir> <cols> <out.png>  -> tiles every png in dir (sorted)
d=$1; c=$2; o=$3; n=$(ls $d/*.png | wc -l); r=$(( (n + c - 1) / c ))
ffmpeg -y -loglevel error -pattern_type glob -i "$d/*.png" -vf "scale=640:-1,tile=${c}x${r}" -frames:v 1 $o
