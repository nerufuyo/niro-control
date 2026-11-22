#!/usr/bin/env python3
"""Judges tests/shell/island-steps-lifecycle.sh: its census.txt has one line a state, CENSUS_<label> {json}. After every disable the shell must
look like the baseline (the island disabled): the same UI group and chrome, no more signals on the shell's long-lived objects, and no more
timeouts than the baseline had (the count may not grow from one cycle to the next)."""
import json, re, sys

out = sys.argv[1].rstrip('/')
census = {}
for label in ['baseline'] + [f'disabled_{n}' for n in range(1, 6)]:
    census[label] = json.load(open(f'{out}/census-{label}.json'))
base = census['baseline']
fails = 0
print('instruments saw (after 5 cycles)', census['disabled_5']['instrumented'])
print(f"baseline: uiGroup {base['uiGroup']} chrome {base['chrome']} timeouts {base['timeouts']} conns {base['conns']}")
prev = base
for n in range(1, 6):
    c = census[f'disabled_{n}']
    problems = []
    for key in ('uiGroup', 'chrome', 'conns'):
        if c[key] != base[key]:
            problems.append(f"{key} {c[key]} != baseline {base[key]}")
    if c['timeouts'] > base['timeouts']:
        problems.append(f"timeouts {c['timeouts']} > baseline {base['timeouts']}: {c['leftoverTimeouts']}")
    fails += len(problems)
    print(f"disabled_{n}: uiGroup {c['uiGroup']} chrome {c['chrome']} timeouts {c['timeouts']} conns {c['conns']}  {'ok' if not problems else 'FAIL ' + '; '.join(problems)}")
print("ISLAND_LIFECYCLE_FAILS", fails)
sys.exit(1 if fails else 0)
