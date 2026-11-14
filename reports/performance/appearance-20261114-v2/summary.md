# Window effects: runs and summary

Machine load average at the start of each run is in runs.tsv (columns load_start, load_end). Failed runs are listed, not dropped.

| Variant | ok / runs | idle CPU % median / p95 | PSS MB | frame interval ms median / p95 (during motion) | fps in motion |
|---|---|---|---|---|---|
| legacy | 5 / 5 | 0.10 / 0.10 (n=5) | 182.00 / 185.00 (n=5) | 8.08 / 8.11 (n=5) median-of-medians; p95s 20.81 / 21.14 (n=5) | 120.20 / 120.30 (n=5) |
| engine | 5 / 5 | 0.10 / 0.20 (n=5) | 179.00 / 186.00 (n=5) | 8.09 / 8.20 (n=5) median-of-medians; p95s 20.70 / 20.87 (n=5) | 120.30 / 120.70 (n=5) |
| heavy | 5 / 5 | 0.10 / 0.20 (n=5) | 182.00 / 185.00 (n=5) | 8.11 / 8.17 (n=5) median-of-medians; p95s 16.87 / 20.94 (n=5) | 120.00 / 120.30 (n=5) |
| safe | 5 / 5 | 0.10 / 0.10 (n=5) | 181.00 / 185.00 (n=5) | 8.04 / 8.12 (n=5) median-of-medians; p95s 20.91 / 21.06 (n=5) | 120.30 / 120.70 (n=5) |
| none | 5 / 5 | 0.05 / 0.05 (n=5) | 179.00 / 183.00 (n=5) | 16.50 / 16.51 (n=5) median-of-medians; p95s 19.10 / 19.12 (n=5) | 60.20 / 60.30 (n=5) |

Failed runs: 0

Load average at start of runs: median 1.15, max 2.60.
