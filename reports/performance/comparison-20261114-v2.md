# Universal Appearance 2.1: performance (headless, same methods as before, load documented)

Machine: AMD Ryzen 5 5600G, GNOME Shell 46. Load average (1 min) at the start of each run is in the tables. **Headless measurements only** (private shells with throw-away settings); the one real-session figure is read-only and uncontrolled.

## Window effects (`scripts/benchmark-appearance.sh`, 5 runs per variant, 25 of 25 completed, none dropped)
Run folder: `appearance-20261114-v2/` (`runs.tsv` has every run with its load, `summary.md` the medians). Load at the start of runs: median 1.15, max 2.60. Six GTK 4 windows, 20 s idle, then 6 s of one window moved continuously.

| Variant | idle CPU % (median) | PSS MB (median) | frame interval while moving, median / p95-of-p95s | frames per second |
|---|---|---|---|---|
| legacy (old whole-window fade, installed extension) | 0.10 | 182 | 8.08 ms / 21.1 | 120 |
| engine (new, no fade, blur 30) | 0.10 | 179 | 8.09 ms / 20.9 | 120 |
| heavy (blur 100) | 0.10 | 182 | 8.11 ms / 20.9 | 120 |
| safe (no blur, no fade) | 0.10 | 181 | 8.04 ms / 21.1 | 120 |
| none (no blur extension) | 0.05 | 179 | 16.50 ms / 19.1 | 60 |

Reading: the engine, the old fade, heavy blur and safe mode are indistinguishable from each other in CPU, memory and frame interval. Every variant with the blur extension loaded paints about twice as often while a window moves (120 against 60 frames per second) than without it; that is the extension's own repaint scheduling, it is the same with blur off (safe) and with the old code (legacy), so it is not something Universal Appearance added or removed. The blur radius (30 against 100) made no measurable difference to frame intervals in this setup (no GPU measurement was taken). Not measured: GPU load, battery, several monitors, video, screen sharing, high-resolution displays, application start-up.

## Appearance change (`scripts/benchmark-sync.sh`, 3 runs, 20 changes and 200 changes each; load 0.45 to 1.34)
| | median | p95 |
|---|---|---|
| Look change to the GTK stylesheet rewritten | 404.5 to 405.1 ms | 406 ms |
| Look change to the Shell stylesheet rewritten | 273.5 to 276.1 ms | 277 to 288 ms |

These are the debounce delays (400 ms and 250 ms) plus a few milliseconds of work, by design: a preset or profile writes several keys at once and each stylesheet is built once. Shell PSS before and after 200 changes: 246.6 to 246.7, 241.7 to 241.8, 238.6 to 238.8 MB: no measurable growth.

## Control Panel (`scripts/benchmark-performance.sh --cold`, one run each)
| | before: Compatibility page built at start (13:45, load 0.45) | after: built when first shown (14:17, load 1.95) |
|---|---|---|
| later starts, first frame, median / p95 | 716 / 727 ms | 538 / 546 ms |
| idle PSS | 173 MB | 109 MB |
| idle CPU | 0.45 % | 0.39 % |
| module switch drawn, median / p95 | 28 / 81 ms | 29 / 326 ms |

The Compatibility page lists every installed application; building it at start cost memory and about 180 ms. It is now built when first shown, so the panel starts faster and lighter, and the first visit to that page costs about 300 ms (the p95 above). One run each, with different machine load (the second was the busier one, so the difference is not flattered by load), a cold first run of 908 ms and 746 ms respectively: treat the size of the difference as approximate. The earlier baseline (commit `c09f3f7`, 503 ms, 133 MB PSS) had 132 settings and no Compatibility page.

## Real session (read-only, uncontrolled)
The real shell's idle CPU read 2.7 %, 9.8 %, 17.9 % and 24.8 % in four samples hours apart, at varying machine load: it is dominated by what else the desktop was doing. No conclusion about Universal Appearance can be drawn from it. Not measured: frame timing or animation smoothness on the real desktop.
