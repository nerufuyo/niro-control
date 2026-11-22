#!/usr/bin/env python3
"""Turns the captures (3840x2160 PNG, from capture/steps-film-1|2|3.sh) into the JPEGs the film reads from shots/.
usage: prep-shots.py <dir of steps-film-1> <dir of steps-film-2> <dir of steps-film-3>"""
import sys
from pathlib import Path
from PIL import Image
one, two, three = (Path(p) for p in sys.argv[1:4])
out = Path(__file__).resolve().parent / 'shots'; out.mkdir(exist_ok=True)
names = {one: ['s-open', 's-a', 's-ac', 's-acc', 's-accent', 's-calc', 's-unit', 's-zone'],
         two: ['desk', 'isl-closed', 'isl-open-1', 'isl-open-2', 'isl-open-3', 'isl-open', 'dock-790', 'dock-880', 'dock-960', 'dock-1040', 'dock-1130',
               'tile-off', 'tile-dwindle', 'tile-m-1', 'tile-m-2', 'tile-m-3', 'tile-m-4', 'tile-master', 'tile-g-1', 'tile-g-2', 'tile-g-3', 'tile-g-4', 'tile-grid',
               'panel-home', 'panel-profiles', 'panel-profiles-applied', 'flow-before', 'flow-after'],
         three: ['windows2']}
for d, ns in names.items():
    for n in ns:
        Image.open(d / f'{n}.png').convert('RGB').save(out / f'{n}.jpg', quality=93)
print(sum(len(v) for v in names.values()), 'frames ->', out)
