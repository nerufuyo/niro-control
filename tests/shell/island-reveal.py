#!/usr/bin/env python3
"""Judges the per-frame content opacities tests/shell/island-steps-content.sh recorded: rows [ms, label, [opacity, ...]].
Reveal: each piece, once reset to nothing, rises after the one before it (cover, words, progress, controls). Retreat: the reverse (controls
first, cover last). A retreat turned round: nothing reaches zero and nothing jumps. A routine alert: no stagger; a critical one: staggered.
The split's second zone rises a beat after it was put in place (the shape makes room first)."""
import json, sys

FRAME_JUMP = 140   # opacity points in one frame: a fade over ~200 ms moves ~20 a frame; this catches a blink
rows = json.load(open(sys.argv[1]))
by = {}
for ms, label, values in rows:
    by.setdefault(label, []).append((ms, values))
fails = 0

def fail(msg):
    global fails
    fails += 1
    print("FAIL", msg)

def series(frames):
    n = max((len(v) for _, v in frames), default=0)
    t0 = frames[0][0]
    return [[(ms - t0, v[i]) for ms, v in frames if len(v) > i] for i in range(n)]

def reset_and_rise(s):
    """(time it was at nothing, time it first rose again): None where it never did."""
    zero = next((t for t, o in s if o <= 8), None)
    if zero is None:
        return None, None
    rise = next((t for t, o in s if t > zero and o > 8), None)
    return zero, rise

def leaves(s):
    """Time it first fell from whole by more than 8 points."""
    return next((t for t, o in s if o < 247), None)

for label, frames in by.items():
    if label == 'start' or len(frames) < 4:
        continue
    ss = series(frames)
    if not ss:
        continue
    jump = max((abs(b[1] - a[1]) for s in ss for a, b in zip(s, s[1:])), default=0)
    line = f"{label:18} {len(frames):4} frames  max step {jump:3.0f}"
    if label == 'split_in':
        zero, rise = reset_and_rise(ss[1])
        lead_min = min(o for _, o in ss[0])
        wait = None if rise is None else rise - zero
        line += f"  second zone put in at {zero:.0f} ms, rises after {wait if wait is None else round(wait)} ms; first sign min opacity {lead_min}"
        if rise is None:
            fail(f"{label}: the second zone never appeared")
        elif wait < 60:
            fail(f"{label}: the second zone rose {wait:.0f} ms after it was put in, before the shape made room")
        if lead_min < 250:
            fail(f"{label}: the first sign blinked (min opacity {lead_min})")
    elif label == 'split_out':
        # (a row recorded between the next step's expression and its label has another shape: only this label's own rows count)
        seen = [v[2] for _, v in frames if len(v) == 3 and v[2] >= 0]
        line += f"  leaving sign fades as a ghost: {len(seen)} frames, from {max(seen) if seen else None}"
        if len(seen) < 3 or max(seen) < 100:
            fail(f"{label}: the sign that left did not fade out (ghost seen in {len(seen)} frames)")
        if max((abs(b - a) for a, b in zip(seen, seen[1:])), default=0) > FRAME_JUMP:
            fail(f"{label}: the leaving sign vanished in one frame")
    elif label in ('reveal_full', 'reveal_reduced') or label.startswith('reveal_off'):
        rises = [reset_and_rise(s)[1] for s in ss]
        low = min(o for s in ss for _, o in s)
        line += f"  piece rises at (ms) {[None if r is None else round(r) for r in rises]}, lowest opacity {low}"
        if label == 'reveal_full' and (None in rises or rises[-1] - rises[0] < 40):
            fail(f"{label}: full motion does not stagger the pieces {rises}")
        if label == 'reveal_reduced' and (None in rises or rises[-1] - rises[0] > 40):
            fail(f"{label}: reduced motion does not bring the pieces in together {rises}")
        if label.startswith('reveal_off') and low < 250:
            fail(f"{label}: motion is off but a piece faded in (lowest opacity {low})")
    elif label in ('reveal_open', 'reveal_again'):
        rises = [reset_and_rise(s)[1] for s in ss]
        line += f"  piece rises at (ms) {[None if r is None else round(r) for r in rises]}"
        if None in rises or any(b < a for a, b in zip(rises, rises[1:])) or rises[-1] - rises[0] < 40:
            fail(f"{label}: the pieces do not reveal in order {rises}")
        if any(s[-1][1] < 250 for s in ss):
            fail(f"{label}: a piece did not end whole")
    elif label == 'retreat_gone':
        offs = [leaves(s) for s in ss]
        line += f"  piece leaves at (ms) {[None if r is None else round(r) for r in offs]}"
        if None in offs or any(b > a for a, b in zip(offs, offs[1:])) or offs[0] - offs[-1] < 40:
            fail(f"{label}: the pieces do not leave in reverse {offs}")
    elif label == 'retreat_turned':
        low = min(o for s in ss for _, o in s)
        line += f"  lowest opacity {low}"
        if jump > FRAME_JUMP:
            fail(f"{label}: a piece jumped {jump} points in a frame")
        if low <= 0:
            fail(f"{label}: a piece reached nothing before it came back")
        if any(s[-1][1] < 250 for s in ss):
            fail(f"{label}: a piece did not come back whole")
    elif label == 'alert_critical':
        rises = [reset_and_rise(s)[1] for s in ss]
        shown = [r for r in rises if r is not None]
        line += f"  piece rises at (ms) {[None if r is None else round(r) for r in rises]}"
        if len(shown) < 2 or any(b < a for a, b in zip(shown, shown[1:])) or shown[-1] - shown[0] < 25:
            fail(f"{label}: a critical alert's pieces do not reveal in order {rises}")
    elif label == 'alert_routine':
        low = min(o for s in ss for _, o in s)
        line += f"  lowest piece opacity {low} (no stagger of its own)"
        if low < 250:
            fail(f"{label}: a routine alert's pieces were staggered (lowest opacity {low})")
    print(line)
print("ISLAND_REVEAL_FAILS", fails)
sys.exit(1 if fails else 0)
