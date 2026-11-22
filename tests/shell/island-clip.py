#!/usr/bin/env python3
"""Judges tests/shell/island-steps-clip.sh's frames (one row per painted frame: [ms, label, [stage, island, lead, right, clock, compact, tab0, tab1,
expanded, page, springW, springH]], each actor [name, x, y, w, h, paint opacity, shown], in screen pixels).

Content actors (the closed island's signs and clock, the open island's first tab and page) are judged while they are SHOWN (paint opacity of at
least VISIBLE of 255):
  NO CUT   never past the stage's clip (the island's surface), by more than CLIP_SLACK px;
  NO JUMP  between two painted frames (not a dropped one) it moves by no more than the stage's own edge moved plus JUMP_SLACK px: so it
           travels with the surface, never to its final place at once.
Exits 1 on a failure. With `off` motion the surface itself jumps, so only NO CUT is judged."""
import json, sys

VISIBLE = 64          # of 255 (a quarter): below this a piece is a ghost of itself, not content the eye reads
PAGE_INSET = 20       # px: a page's content is inset from its box by the header's side padding
CLIP_SLACK = 3        # px, rounding of the stage's whole-pixel edges
JUMP_SLACK = 4        # px beyond the stage's own edge movement in one frame (rounding, the 1 px spring step)
MAX_GAP_MS = 60       # a later frame is a dropped one
NAMES = ['stage', 'island', 'lead', 'right', 'clock', 'compact', 'tab0', 'tab1', 'expanded', 'page']
JUDGED = ['lead', 'right', 'clock', 'tab0', 'tab1', 'page']
off = len(sys.argv) > 2 and sys.argv[2] == 'off'

rows = [r for r in json.load(open(sys.argv[1])) if r[2]]
by = {}
for r in rows:
    by.setdefault(r[1], []).append(r)

def shown(a):
    return a[6] and a[1] is not None and a[5] >= VISIBLE

fails = 0
for label, fr in by.items():
    if label in ('start', 'end') or len(fr) < 3:
        continue
    worst = {}
    for name in JUDGED:
        k = NAMES.index(name)
        jump = cut = 0.0
        jump_at = cut_at = 0
        # Pairs run across the labels (the frame that carries an action is the first of its label, the one before it the last of the
        # label before): the pair belongs to the later frame's label.
        pairs = [(a, b) for a, b in zip(rows, rows[1:]) if b[1] == label]
        for a, b in pairs:
            A, B, SA, SB = a[2][k], b[2][k], a[2][0], b[2][0]
            if shown(B):
                pad = PAGE_INSET if name == 'page' else 0
                over = max(SB[1] - (B[1] + pad), (B[1] + B[3] - pad) - (SB[1] + SB[3]))
                if over > cut:
                    cut, cut_at = over, b[0] - fr[0][0]
            if off or not (shown(A) and shown(B)) or b[0] - a[0] > MAX_GAP_MS:
                continue
            edge = max(abs(SB[1] - SA[1]), abs((SB[1] + SB[3]) - (SA[1] + SA[3])))
            move = max(abs(B[1] - A[1]), abs((B[1] + B[3]) - (A[1] + A[3])))
            if move - edge > jump:
                jump, jump_at = move - edge, b[0] - fr[0][0]
        worst[name] = (jump, jump_at, cut, cut_at)
    bad = [n for n, (j, _, c, _) in worst.items() if j > JUMP_SLACK or c > CLIP_SLACK]
    fails += bool(bad)
    cells = ' | '.join(f"{n} jump {j:.0f}@{ja:.0f} cut {c:.0f}@{ca:.0f}" for n, (j, ja, c, ca) in worst.items() if j or c)
    print(f"{'FAIL' if bad else 'ok  '} {label:22} {len(fr):4} frames  {cells or 'nothing moved off its edge, nothing cut'}")
print('CLIP_JUDGE ' + ('FAIL' if fails else 'PASS'))
sys.exit(1 if fails else 0)
