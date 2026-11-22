#!/usr/bin/env python3
"""Judges the frames tests/shell/island-steps-motion.sh recorded (see island-steps-lib.sh for the row layout).
Per movement: the shape's path (which axis leads, overshoot), and continuity: between two on-time frames the spring value must move by what
its own velocity says (|delta - mean velocity * dt|), so a retarget that dropped the velocity, or a jump, shows. Exits 1 on a failure."""
import json, sys

MAX_GAP_MS = 80       # a later frame is a dropped one: not judged
RESIDUAL_PX = 5.0     # allowed |delta - v*dt| per frame, px: a peak-speed frame moves ~50 px, so a dropped velocity or a jump is far above this
OVERSHOOT = 0.08      # of the span, for a size spring (it is elastic by design: ~3.5%)

rows = json.load(open(sys.argv[1]))
by = {}
for r in rows:
    by.setdefault(r[6], []).append(r)
fails = 0
for label, frames in by.items():
    if label.startswith('off_'):
        # Instant: the shape is at its target within a frame or two (no spring runs), and ended there.
        last = frames[-1]
        ok = len(frames) <= 3
        print(f"{label:28} {len(frames):4} frames  ends w {last[8]:.1f} h {last[9]:.1f}  {'instant' if ok else 'NOT instant'}")
        if not ok:
            fails += 1
            print(f"FAIL {label}: motion is off but the shape took {len(frames)} frames")
        continue
    if len(frames) < 4 or label in ('start', 'end'):
        continue
    t = [f[0] for f in frames]
    out = []
    for name, vi, ii in (('width', 11, 8), ('height', 12, 9)):
        worst = 0.0
        at = 0
        for a, b in zip(frames, frames[1:]):
            dt = (b[0] - a[0]) / 1000
            if dt * 1000 > MAX_GAP_MS or dt <= 0:
                continue
            residual = abs((b[ii] - a[ii]) - 0.5 * (a[vi] + b[vi]) * dt)
            if residual > worst:
                worst, at = residual, b[0] - t[0]
        out.append((name, worst, at))
    first, last = frames[0], frames[-1]
    spans = {'width': abs(last[8] - first[8]), 'height': abs(last[9] - first[9])}
    lead = []
    halves = {}
    for name, ii in (('width', 8), ('height', 9)):
        span = spans[name]
        if span < 30:
            continue
        half = first[ii] + (last[ii] - first[ii]) / 2
        up = last[ii] >= first[ii]
        hit = next((f[0] - t[0] for f in frames if (f[ii] >= half if up else f[ii] <= half)), None)
        halves[name] = hit
        lead.append(f"{name} half at {hit:.0f} ms" if hit is not None else f"{name} never half")
    over = []
    for name, ii in (('width', 8), ('height', 9)):
        span = spans[name]
        if span < 40 or label.startswith('interrupt'):
            continue
        a, b = first[ii], last[ii]
        beyond = (max(f[ii] for f in frames) - max(a, b)) if b >= a else (min(a, b) - min(f[ii] for f in frames))
        over.append(f"{name} overshoot {100 * max(0, beyond) / span:.1f}%")
        if label.startswith('reduced_') and beyond > 0.005 * span:
            fails += 1
            print(f"FAIL {label}: reduced motion overshoots ({name} {100 * beyond / span:.1f}%)")
        if label.startswith('full_') and not 0.01 * span < beyond:
            fails += 1
            print(f"FAIL {label}: the full-motion spring did not overshoot ({name} {100 * beyond / span:.1f}%)")
        if beyond > OVERSHOOT * span:
            fails += 1
            print(f"FAIL {label}: {name} overshoots {beyond:.1f} of {span:.0f}")
    states = []
    for f in frames:
        if not states or states[-1] != f[13]:
            states.append(f[13])
    bad = [(n, w, at) for n, w, at in out if w > RESIDUAL_PX]
    for n, w, at in bad:
        fails += 1
        print(f"FAIL {label}: {n} jumps {w:.2f}px off its own velocity at {at:.0f} ms")
    if label.startswith('reduced_') and len(halves) == 2 and abs(halves['width'] - halves['height']) > 40:
        fails += 1
        print(f"FAIL {label}: reduced motion still sequences the axes ({halves})")
    if label.startswith('full_') and 'open' in label and len(halves) == 2 and not halves['width'] + 25 < halves['height']:
        fails += 1
        print(f"FAIL {label}: width does not lead when growing ({halves})")
    print(f"{label:28} {len(frames):4} frames {t[-1]-t[0]:6.0f} ms  w {first[8]:6.1f}->{last[8]:6.1f} h {first[9]:5.1f}->{last[9]:5.1f}  "
          f"max residual w {out[0][1]:.2f} h {out[1][1]:.2f}  {'; '.join(lead)}  {'; '.join(over)}  states {'>'.join(states)}")
print("ISLAND_MOTION_FAILS", fails)
sys.exit(1 if fails else 0)
