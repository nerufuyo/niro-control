#!/usr/bin/env python3
"""Turns the frames face_preview writes into pictures: a contact sheet of the moods, or a strip of one mood over time.
   face_sheet.py sheet DIR OUT.png      face_sheet.py strip DIR OUT.png [COLUMNS]"""
import glob, os, struct, sys
from PIL import Image, ImageDraw

def load(path):
    data = open(path, 'rb').read()
    px = struct.unpack('<%dH' % (240 * 240), data)
    img = Image.new('RGB', (240, 240))
    img.putdata([(((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31) for v in px])
    return img

def sheet(frames, out, cols, labels=None):
    rows = (len(frames) + cols - 1) // cols
    img = Image.new('RGB', (cols * 244 + 4, rows * 260 + 4), (28, 28, 32))
    d = ImageDraw.Draw(img)
    for i, f in enumerate(frames):
        x, y = 4 + (i % cols) * 244, 4 + (i // cols) * 260
        img.paste(f, (x, y))
        if labels: d.text((x + 4, y + 244), labels[i], fill=(200, 200, 210))
    img.save(out)

mode, folder, out = sys.argv[1:4]
if mode == 'sheet':
    names = ['idle', 'happy', 'listening', 'thinking', 'speaking', 'alert', 'waking', 'searching', 'curious', 'sleepy', 'sad', 'love']
    sheet([load(os.path.join(folder, n + '.rgb565')) for n in names], out, 4, names)
else:
    files = sorted(glob.glob(os.path.join(folder, 'strip_*.rgb565')))
    sheet([load(f) for f in files], out, int(sys.argv[4]) if len(sys.argv) > 4 else 6, [os.path.basename(f)[6:9] for f in files])
