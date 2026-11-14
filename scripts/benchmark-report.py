#!/usr/bin/env python3
"""Turns the raw files of scripts/benchmark-performance.sh into JSON and a Markdown summary. Median and p95 over the samples taken."""
import json, os, re, sys, statistics

raw, base, N, IDLE = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def read(name):
    try: return open(os.path.join(raw, name)).read()
    except OSError: return ''
def stats(xs):
    xs = sorted(float(x) for x in xs)
    if not xs: return None
    p95 = xs[min(len(xs) - 1, max(0, round(0.95 * len(xs) + 0.5) - 1))]
    return {"n": len(xs), "median": round(statistics.median(xs), 3), "p95": round(p95, 3), "min": round(xs[0], 3), "max": round(xs[-1], 3)}
def kv(text):
    out = {}
    for line in text.splitlines():
        k, _, v = line.partition(' ')
        out.setdefault(k, v)
    return out
def mem(v): return {m[0].lower() + '_mb': float(m[1]) for m in re.findall(r'(Rss|Pss):?=([\d.]+)', v or '')} or None
def cpu(v):
    m = re.match(r'(\d+) over (\d+)s', v or '')
    return round(int(m[1]) / 100 / int(m[2]) * 100, 2) if m else None  # ticks are 1/100 s

system = dict(l.split(': ', 1) for l in read('system.txt').splitlines() if ': ' in l)
try: profiles = {k: stats(v) for k, v in json.loads(read('profiles.json') or '{}').items()}
except ValueError: profiles = {}

def session(mode):
    d = kv(read(f'session-{mode}.txt'))
    if not d: return None
    r = {"settled_mem": mem(d.get('settled_mem')), "idle_mem": mem(d.get('idle_mem')), "idle_cpu_percent": cpu(d.get('idle_cpu_ticks')),
         "extensions": d.get('extensions'), "log_error_lines": int(d.get('errors', -1)),
         "log_errors_sample": [l[:200] for l in read(f'shell-{mode}.log').splitlines() if re.search(r'error|exception', l, re.I)][:6]}
    if mode == 'on':
        search = {}
        for part in re.sub(r'^\(true, |[\'\"\)]', '', d.get('SEARCH', '')).split(';'):
            k, _, v = part.partition(':')
            if v: search[k] = stats(v.split(','))
        r["search_ms"] = search
        r["growth_pss_mb_after_each_300_cycles"] = [mem(d.get(f'growth_{i}'))['pss_mb'] if mem(d.get(f'growth_{i}')) else None for i in range(4)]
        panels = [json.loads(l[6:]) for l in read(f'session-{mode}.txt').splitlines() if l.startswith('PANEL {')]
        r["panel_runs"] = len(panels)
        if panels:
            r["panel"] = {"first_run_first_frame_ms": round(panels[0]['first_frame_ms'], 1), "later_first_frame_ms": stats([p['first_frame_ms'] for p in panels[1:]]),
                          "idle_cpu_percent": stats([p['idle_cpu_percent'] for p in panels]), "idle_rss_mb": stats([p['rss_mb'] for p in panels]),
                          "idle_pss_mb": stats([p['pss_mb'] for p in panels]), "navigation_ms": stats([x for p in panels for x in p['nav_ms']])}
    return r

rd = kv(read('real.txt'))
real = {"pid": rd.get('pid'), "mem": mem(rd.get('mem')), "mem_after_idle": mem(rd.get('mem_after')), "threads": rd.get('threads'), "idle_cpu_percent": cpu(rd.get('idle_cpu_ticks')),
        "voluntary_wakeups_per_s": rd.get('wakeups_per_s'), "niro_journal_error_lines_this_boot": rd.get("journal_errors"),
        "island_daemon_mem": mem(rd.get('daemon_mem'))} if rd else None
report = {"system": system, "cold_note": read('cold.txt').strip(), "samples_requested": int(N), "idle_window_s": IDLE,
          "isolated": {"profiles_ms": profiles, "shell_with_niro": session('on'), "shell_stock": session('off')}, "real_session": real,
          "not_measured": ["Search latency is JS time inside the shell, not to-pixel", "first-result latency equals query latency (results are built synchronously)",
                           "real-session search latency: driving the real shell was not done", "real-session cold panel start"]}
json.dump(report, open(base + '.json', 'w'), indent=2)

f = lambda s: f"{s['median']} / {s['p95']}" if s else 'unavailable'
on, off = report['isolated']['shell_with_niro'], report['isolated']['shell_stock']
L = [f"# Niro Control performance report ({system.get('date')}, {system.get('commit')})", "",
     "No historical baseline exists: these numbers establish one. They claim no improvement.", "",
     "## Conditions", *[f"- {k}: {v}" for k, v in system.items()], f"- {report['cold_note']}", f"- samples: {N} (profiles, search), idle window {IDLE}s", "",
     "## Isolated: Control Panel (headless shell, throw-away settings)"]
p = on and on.get('panel')
if p:
    L += [f"- first run first-frame: {p['first_run_first_frame_ms']} ms (see conditions: cold only if the cache was dropped)", f"- later runs first-frame, median / p95: {f(p['later_first_frame_ms'])} ms",
          f"- idle RSS {f(p['idle_rss_mb'])} MB, idle PSS {f(p['idle_pss_mb'])} MB, idle CPU {f(p['idle_cpu_percent'])} %", f"- module switch drawn, median / p95: {f(p['navigation_ms'])} ms (n={p['navigation_ms']['n']})"]
else: L.append("- unavailable (the panel did not report)")
L += ["", "## Isolated: Search 2.0 (JS time in the shell, ms, median / p95)"]
for k, v in (on or {}).get('search_ms', {}).items(): L.append(f"- {k}: {f(v)}")
if not (on or {}).get('search_ms'): L.append("- unavailable")
L += ["", "## Isolated: profile engine (ms, median / p95)"] + [f"- {k}: {f(v)}" for k, v in profiles.items()] + ["", "## Isolated: GNOME Shell with and without the Niro extensions"]
for name, s in (("with Niro", on), ("stock", off)):
    L.append(f"- {name}: " + (f"RSS/PSS settled {s['settled_mem']}, after idle {s['idle_mem']}, idle CPU {s['idle_cpu_percent']} %, extensions: {s['extensions']}, error lines in log: {s['log_error_lines']}" if s else "unavailable"))
if on: L.append(f"- shell PSS MB before and after each of 3 rounds of 300 open/query/close cycles (GC forced after each): {on['growth_pss_mb_after_each_300_cycles']}. Per-round growth shrinking means a warm-up cache, a constant one means a leak.")
L += ["", "## Real session (read-only)"]
L += [f"- {k}: {v}" for k, v in real.items()] if real else ["- unavailable (no gnome-shell process)"]
L += ["", "## Not measured", *[f"- {x}" for x in report['not_measured']]]
open(base + '.md', 'w').write('\n'.join(L) + '\n')
print('\n'.join(L))
