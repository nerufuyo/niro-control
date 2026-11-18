#!/usr/bin/env python3
"""Judges the frames tests/shell/motion.sh recorded: [ms, width, height, x, y, opacity, label] a frame.
Prints one line a movement and exits 1 when any breaks a rule. The rules are what a spring does (see shell/island/src/spring.ts):
no jump of more than JUMP px (or opacity points) between two frames that are one frame apart, no change at all once at rest
(a pixel that flickers), and no overshoot of more than OVERSHOOT of the distance travelled."""
import json, statistics, sys

JUMP = 90          # px from one frame to the next (a spring of this stiffness moves a fraction of this)
OPACITY_JUMP = 120  # opacity points a frame (255 is full)
OVERSHOOT = 0.12   # of the distance travelled
REST_MS = 600      # the last stretch of a movement that must be still
MAX_GAP_MS = 80    # a frame this late is a dropped one: counted, told, not failed (a software renderer is slow)

rows = json.load(open(sys.argv[1]))
if len(rows) < 100:
    print(f"FAIL recorded only {len(rows)} frames"); sys.exit(1)
by = {}
for r in rows:
    by.setdefault(r[6], []).append(r)
fails = 0
for label, frames in by.items():
    if len(frames) < 3:
        continue
    t = [f[0] for f in frames]
    gaps = [b - a for a, b in zip(t, t[1:])]
    dropped = sum(1 for g in gaps if g > MAX_GAP_MS)
    problems = []
    for name, idx, limit in (("width", 1, JUMP), ("height", 2, JUMP), ("x", 3, JUMP), ("y", 4, JUMP), ("opacity", 5, OPACITY_JUMP)):
        for a, b, gap in zip(frames, frames[1:], gaps):
            # A late frame covers more time: only the jumps between frames that are on time count.
            if gap <= MAX_GAP_MS and abs(b[idx] - a[idx]) > limit:
                problems.append(f"{name} jumps {abs(b[idx]-a[idx]):.0f} in one frame at {b[0]-t[0]:.0f} ms")
                break
    # Rest: the last REST_MS of the movement does not change, in any value.
    end = t[-1]
    tail = [f for f in frames if end - f[0] <= REST_MS]
    for name, idx in (("width", 1), ("height", 2), ("x", 3), ("y", 4)):
        values = {round(f[idx], 2) for f in tail}
        # Closed ends in the same place; a still island has one value. Two or more at the end is shaking.
        if len(tail) > 10 and len(values) > 1 and max(values) - min(values) > 0.5 and len(tail) == len(frames[-len(tail):]):
            # Only judge segments that had time to settle (the rapid ones are cut off by the next step).
            if not label.startswith(("page_rapid", "reopen_interrupt", "open_close_open")):
                problems.append(f"{name} still moves in its last {REST_MS} ms ({min(values):.1f}..{max(values):.1f})")
    # Overshoot of the size: against where it ends.
    for name, idx in (("width", 1), ("height", 2)):
        first, last = frames[0][idx], frames[-1][idx]
        span = abs(last - first)
        if span > 40 and not label.startswith(("page_rapid", "reopen_interrupt", "open_close_open")):
            beyond = (max(f[idx] for f in frames) - max(first, last)) if last >= first else (min(first, last) - min(f[idx] for f in frames))
            if beyond > OVERSHOOT * span:
                problems.append(f"{name} overshoots by {beyond:.0f} of {span:.0f}")
    # What the island holds (its views): each one's opacity must not blink, nothing may sit empty, nothing may shake sideways.
    names = {k[0] for f in frames for k in f[7]}
    for name in sorted(names):
        series = []
        for f in frames:
            k = next((k for k in f[7] if k[0] == name), None)
            series.append(k)
        shown = [k for k in series if k and k[1]]
        if len(shown) < 5:
            continue
        # A blink: the opacity falls and then rises again by more than BLINK, with no reason to (a view coming back mid-fade
        # may rise from where it is, but not after a fall of this size).
        opacity = [k[2] if k and k[1] else None for k in series]
        run = [o for o in opacity if o is not None]
        falls = rises = 0
        peak = run[0]
        for before, after in zip(run, run[1:]):
            if after < before - 2:
                falls += before - after
            elif after > before + 2:
                rises += after - before
        # Fell and rose by a lot, twice over: it blinked.
        if falls > 200 and rises > 200 and not label.startswith(("page_rapid", "reopen_interrupt", "open_close_open")):
            problems.append(f"{name} blinks (fell {falls}, rose {rises} opacity points)")
        xs = {round(k[4], 1) for k in shown}
        if len(xs) > 3 and max(xs) - min(xs) > 6 and not label.startswith(("open", "close", "final", "reopen", "page_rapid")):
            problems.append(f"{name} shifts sideways by {max(xs)-min(xs):.0f} px")
    # Empty: the island body is shown but none of its views is (for more than a few frames).
    blank = 0; worst = 0
    for f in frames:
        total = sum(k[2] for k in f[7] if k[1])
        blank = blank + 1 if (f[5] > 200 and f[1] > 300 and total < 40) else 0
        worst = max(worst, blank)
    # Hollow: while it is wide, what it holds together never falls under a quarter of full (a cross-fade that drops one view
    # before the next is in leaves a wide, empty island for a moment: it reads as a flash).
    dip = min((sum(k[2] for k in f[7] if k[1]), f[0] - t[0], f[1]) for f in frames if f[5] > 200 and f[1] > 250 and f[7]) if any(f[5] > 200 and f[1] > 250 for f in frames) else None
    if dip and dip[0] < 64 and not label.startswith(("page_rapid", "reopen_interrupt", "open_close_open")):
        problems.append(f"the island holds only {dip[0]:.0f} of 255 at {dip[1]:.0f} ms, {dip[2]:.0f} px wide (a cross-fade that empties it)")
    if worst > 4:
        problems.append(f"the island is open and empty for {worst} frames in a row")
    status = "FAIL" if problems else "ok  "
    fails += bool(problems)
    print(f"{status} {label}: {len(frames)} frames, median {statistics.median(gaps):.1f} ms, {dropped} late" + ("".join(f"\n       - {p}" for p in problems)))
print("motion: " + ("some movements are not clean" if fails else "all clean"))
sys.exit(1 if fails else 0)
