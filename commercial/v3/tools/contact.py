# per-shot contact sheet from a rendered video: 5 frames per shot (start, 25 %, 50 %, 75 %, end) -> out PNGs (two halves)
import json, subprocess, sys, os
vid, out = sys.argv[1], sys.argv[2]; tall = len(sys.argv) > 3 and sys.argv[3] == 'tall'
ev = json.load(open('audio/sync.json'))['events']
cuts = [0, ev['cut-s02'], ev['cut-s03'], ev['cursor-in'], ev['pullback'], ev['cut-s06'], ev['cut-s07'], ev['cut-s08'], ev['cut-s09'], ev['cut-s10'], ev['cut-s11'], ev['cut-s12'], 45]
os.makedirs('/tmp/ct', exist_ok=True); rows = []
w, h = (216, 384) if tall else (384, 216)
for i in range(12):
    a, b = cuts[i], cuts[i + 1]; fr = []
    for k, f in enumerate([0.03, 0.25, 0.5, 0.75, 0.97]):
        t = a + (b - a) * f; p = f'/tmp/ct/{i:02d}-{k}.png'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', vid, '-frames:v', '1', '-vf', f'scale={w}:{h}', p], check=True); fr.append(p)
    r = f'/tmp/ct/row{i:02d}.png'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error'] + sum([['-i', p] for p in fr], []) + ['-filter_complex', 'hstack=5', r], check=True); rows.append(r)
for half, rs in ((1, rows[:6]), (2, rows[6:])):
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error'] + sum([['-i', r] for r in rs], []) + ['-filter_complex', 'vstack=6', f'{out}-{half}.png'], check=True)
print('ok')
