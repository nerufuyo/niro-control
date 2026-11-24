#!/usr/bin/env python3
"""Frame pacing of a screen recording (GNOME's built-in recorder: Ctrl+Shift+Alt+R, or a phone/camera video of the screen).

usage: frame-pacing.py VIDEO [--hz 60] [--gap-ms 100] [--json OUT.json]

Reads every frame's timestamp with ffprobe and reports the interval between frames inside bursts of activity.
What this can and cannot say (read before quoting a number):
  * GNOME's recorder is damage driven: it writes a frame only when the screen changed, so a still desktop leaves long gaps.
    Intervals longer than --gap-ms end a burst and are not counted as stalls. Only the bursts are judged.
  * The recorder itself costs CPU/GPU and can drop frames it could not encode: a bad number here may be the recording, not the
    shell. Repeat a suspect run without recording (probe 'frames') or with a phone video before calling it a defect.
  * A phone video at 240 fps shows the physical panel; its frames are camera-timed, so use --hz 240 and look at the burst's
    duration and at repeated picture content, not at the interval of camera frames.
It never changes any animation setting and gives no pass/fail: it prints late-frame counts for a person to judge.
"""
import argparse, json, subprocess, statistics, sys


def frame_times(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time,pts_time',
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout
    ts = []
    for line in out.splitlines():
        for tok in line.split(','):
            try:
                ts.append(float(tok) * 1000.0); break
            except ValueError:
                continue
    return ts


def pct(v, p):
    s = sorted(v)
    return s[min(len(s) - 1, int(p * len(s)))] if s else None


def analyse(ts, hz, gap_ms):
    bursts, cur = [], []
    for a, b in zip(ts, ts[1:]):
        d = b - a
        if d > gap_ms:
            if len(cur) >= 3: bursts.append(cur)
            cur = []
        else:
            cur.append(d)
    if len(cur) >= 3: bursts.append(cur)
    allv = [d for b in bursts for d in b]
    nominal = 1000.0 / hz if hz else (statistics.median(allv) if allv else None)
    res = {'frames': len(ts), 'duration_s': round((ts[-1] - ts[0]) / 1000, 2) if len(ts) > 1 else 0, 'bursts': len(bursts), 'nominal_ms': round(nominal, 2) if nominal else None}
    if allv:
        res.update({'interval_ms': {'n': len(allv), 'min': round(min(allv), 2), 'p50': round(pct(allv, .5), 2), 'p95': round(pct(allv, .95), 2),
                                    'p99': round(pct(allv, .99), 2), 'max': round(max(allv), 2)},
                    'late_over_1_5x': sum(d > nominal * 1.5 for d in allv), 'late_over_2x': sum(d > nominal * 2 for d in allv),
                    'effective_fps_in_bursts': round(1000 * len(allv) / sum(allv), 1)})
        res['per_burst'] = [{'frames': len(b) + 1, 'ms': round(sum(b)), 'worst_ms': round(max(b), 1), 'late_over_2x': sum(d > nominal * 2 for d in b)} for b in bursts]
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video'); ap.add_argument('--hz', type=float, default=0, help='nominal refresh rate; default: the median interval')
    ap.add_argument('--gap-ms', type=float, default=100); ap.add_argument('--json')
    a = ap.parse_args()
    ts = frame_times(a.video)
    if len(ts) < 4: sys.exit('fewer than 4 frames: nothing to analyse')
    r = analyse(ts, a.hz, a.gap_ms)
    print(json.dumps(r, indent=1))
    if a.json: json.dump(r, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
