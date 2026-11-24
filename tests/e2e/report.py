#!/usr/bin/env python3
"""Renders e2e-results.json files (one or more runs) as the automated E2E report. usage: report.py OUT.md RESULTS.json [RESULTS.json ...]
Every row is tier automated-headless-e2e. The UAT column names the physical scenarios the result informs; it never marks one passed."""
import json, sys, collections

UAT = {'E2E-SRCH-01': 'UAT-SRCH-07', 'E2E-SRCH-02': 'UAT-SRCH-01, 02', 'E2E-SRCH-03': 'UAT-SRCH-04', 'E2E-SRCH-04': 'UAT-SRCH-04', 'E2E-SRCH-05': 'UAT-SRCH-04',
       'E2E-SRCH-06': 'UAT-SRCH-04', 'E2E-SRCH-07': 'UAT-SRCH-07', 'E2E-DOCK-01': 'UAT-DOCK-02, 06', 'E2E-DOCK-02': 'UAT-DOCK-01, 03', 'E2E-ISL-01': 'UAT-ISL-01',
       'E2E-ISL-02': 'UAT-ISL-05', 'E2E-X-01': 'UAT-SRCH-05, UAT-X-01', 'E2E-X-02': 'UAT-SRCH-06, UAT-X-01', 'E2E-A11Y-01': 'UAT-A11Y-01', 'E2E-LIFE-01': 'UAT-LIFE-01, 02',
       'E2E-POC-SRCH-01': 'UAT-SRCH-01, 04', 'E2E-POC-DOCK-01': 'UAT-DOCK-01', 'E2E-POC-ISL-01': 'UAT-ISL-01'}

def main():
    out, files = sys.argv[1], sys.argv[2:]
    runs = [json.load(open(f))['results'] for f in files]
    by = collections.OrderedDict()
    for res in runs:
        for r in res: by.setdefault(r['id'], []).append(r)
    L = ['# Automated E2E report', '',
         f'{len(runs)} run(s) of the suite, each in a fresh isolated GNOME Shell 51 session (headless, virtual 1920x1080 monitor, no unsafe mode). '
         'Tier: **automated-headless-e2e**. Input is mutter\'s RemoteDesktop API (a virtual device in the compositor\'s seat), observation is the test-only telemetry. '
         '**None of this is physical-input UAT**: a row here never turns a UAT scenario into Pass.', '',
         '| Test | Component | Result (runs) | What was asserted | Timings (ms) | Informs UAT (still to run physically) |', '|---|---|---|---|---|---|']
    for i, rs in by.items():
        st = collections.Counter(r['status'] for r in rs); head = rs[0]
        res = ', '.join(f'{v} {k}' for k, v in st.items())
        a = '; '.join(f"{'✓' if x['ok'] else '✗'} {x['name']}" for x in head['assertions'])
        fails = sorted({f"{x['name']}: {x['detail']}" for r in rs for x in r['assertions'] if not x['ok']})
        if fails: a += '<br>**failed:** ' + '; '.join(fails)
        tm = {}
        for r in rs:
            for k, v in r['timings_ms'].items():
                if isinstance(v, (int, float)): tm.setdefault(k, []).append(round(v))
        t = '<br>'.join(f"{k}: {min(v)}-{max(v)}" for k, v in tm.items())
        L.append(f"| {i} {head['scenario']} | {head['component']} | {res} | {a.replace('|', '/')} | {t} | {UAT.get(i, '')} |")
    L += ['', f'Event path observed (examples): {runs[0][0]["event_path_observed"]}', '', 'Statuses: Pass = every assertion held; Fail = one did not; Blocked = the scenario could not run (the reason is in the JSON).']
    open(out, 'w').write('\n'.join(L) + '\n')

main()
