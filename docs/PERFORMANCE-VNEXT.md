# Performance, vNext (wave 1) against the released 1.5.9

Measured on 22 Nov 2026 with `tests/shell/e2e-flow-perf.sh` and `tests/shell/e2e-flow-perf.js`. Everything below comes from
those two files; the numbers are copied from their output, none are estimated. **Read the caveats first: this is a nested,
headless shell on a development machine, not a real desktop.**

## What was compared

| | baseline | vNext |
|---|---|---|
| extensions | the installed package, `/usr/share/gnome-shell/extensions` (niro-control 1.5.9-939, the last release) | this working tree, staged by `tests/shell/stage.sh` (uncommitted wave 1: Search runtime, shared cores, Flow) |
| daemon | `/usr/bin/island-daemon` (1.5.9) | `target/release/island-daemon`, built offline from this tree (`--version` still says 1.5.9) |

Machine: Fedora 45, kernel 7.3.3, GNOME Shell 51.1, 12 logical CPUs, other work going on at the same time (see caveats).

## Method

* One private `dbus-run-session` per run, one `gnome-shell --headless --wayland --no-x11 --unsafe-mode --virtual-monitor 1280x720`
  inside it, `GSETTINGS_BACKEND=memory`. `HOME` and every `XDG_*` folder are a scratch folder, so nothing under the real
  `~/.config/niro`, `~/.local/state/niro` or Search's audit log is read or written. A service file in front of
  `XDG_DATA_DIRS` stops the bus from starting the installed daemon on its own, so the only daemon is the one measured.
* **Extension load**: wall time (`date +%s%N`) from the `enableExtension` call to `state == ACTIVE`, polled through
  `org.gnome.Shell.Eval` in a tight loop. Each poll is a process start of `gdbus` (a few ms), so every figure carries about
  +- 5 ms. "cold" is the first enable in a fresh shell (4 fresh shells per side: 3 extension-only runs and the full run);
  "reload" is disable then enable again in the same shell (5 per run; the modules are already imported).
* **Search dispatch**: a `gjs` client on the same bus calls `org.niro.Search.RunAction` synchronously, 200 times, after 10
  warm-up calls, timing each call with the monotonic clock. Search refuses an identical repeated request as a duplicate, so
  each call carries a different argument (`@I@`). The bus round trip alone is measured with `Peer.Ping` on the same name.
  Actions: `url.clean` (pure, no capability) and `clipboard.copy` (the real shell clipboard).
* **Workflow run** (vNext only, Flow does not exist in 1.5.9): `RunNow` of a one-step workflow (`clipboard.copy`), timed from
  the call until the daemon's `WorkflowCompleted` signal reaches the client. Flow's own guards (5 s cooldown per workflow,
  5 starts per minute per workflow) refuse a quick repeat of one workflow, so 63 distinct workflows are saved and each is run
  once; the first 3 are warm-up, 60 are measured.
* **Daemon idle**: after 8 s of settling, `utime + stime` and `VmRSS` of the daemon's pid are read from `/proc` at the start
  and 45 s later (`CLK_TCK` = 100, so one tick is 0.022 % of one core over 45 s). Three states, in alternating order, two
  rounds each: Flow off (default), Flow on with no workflow (`NIRO_FLOW_ENABLED=1`), Flow on with one `schedule` workflow
  (which is what arms the minute timer).

## Results (milliseconds unless stated)

### Extension load time

| | baseline | vNext |
|---|---|---|
| Search, cold, 4 fresh shells | 44, 42, 42, 42 | 54, 58, 54, 55 |
| Tile, cold | 32, 33, 31, 32 | 37, 44, 39, 35 |
| Search, reload (5 per run, 4 runs) | 21 to 26 | 22 to 25 (one 36) |
| Search disable | 22 to 24 | 23 to 27 |

Reading: Search and Tile are about 10 to 12 ms slower to load the first time (they now import `shared/` cores and, in Search,
the runtime, capabilities and adaptive modules). Once loaded, a reload costs the same. The figures include the polling
overhead described above. No `JS ERROR` line appeared in either shell log in the full runs.

### Search action dispatch (`RunAction`, n = 200, synchronous, one client)

| call | min | median | p95 | max | mean |
|---|---|---|---|---|---|
| bus round trip alone (`Peer.Ping`), baseline | 0.17 | 0.18 | 0.24 | 0.28 | 0.19 |
| bus round trip alone, vNext | 0.15 | 0.17 | 0.19 | 0.23 | 0.17 |
| `clipboard.copy`, baseline | 2.52 | 3.12 | 7.09 | 15.30 | 4.01 |
| `clipboard.copy`, vNext | 2.64 | 3.09 | 9.02 | 12.40 | 4.10 |
| `url.clean`, vNext | 2.49 | 3.11 | 8.18 | 14.77 | 4.14 |

`url.clean` does not exist in 1.5.9 (the baseline answered `unknown action` in 2.74 ms median), so it has no baseline and that
row is not a comparison. The comparable action, `clipboard.copy`, has the same median (3.12 vs 3.09 ms) and the same range
within the spread of one 200-call run. The p95 and max differ between the two sides in both directions (baseline p95 7.09, vNext 9.02; max 15.30 vs 12.40); one
run per side is not enough to say that either tail is better, and the cause of the slow calls was not investigated. The bus
itself is 0.2 ms, so the roughly 3 ms is spent in the shell's handling of the call (not broken down further here).

### Niro Flow workflow run (vNext, n = 60)

| | min | median | p95 | max | mean |
|---|---|---|---|---|---|
| `RunNow` until `WorkflowCompleted` | 5.18 | 6.39 | 9.65 | 10.40 | 6.89 |
| `RunNow` reply only (the run id) | 0.34 | 0.40 | 0.47 | 0.55 | 0.41 |

All 63 runs ended `ok`. The 6.4 ms is the daemon's scheduling and ledger/history write plus one Search `RunAction`
(about 3 ms, from the table above) and the signal; the call itself returns in 0.4 ms. Another run of the same script,
made while developing it, gave a median of 7.28 ms (p95 12.19 ms), so expect about 1 ms of run to run difference.

### Daemon idle (45 s per sample)

| state | CPU ticks in 45 s | RSS at start / end | threads |
|---|---|---|---|
| baseline 1.5.9, round 1 / 2 | 0 / 0 | 8 936 / 8 936 kB, 9 040 / 9 040 kB | 1 |
| vNext, Flow off, round 1 / 2 | 0 / 0 | 9 196 / 9 196 kB, 9 220 / 9 220 kB | 1 |
| vNext, Flow on, no workflow, round 1 / 2 | 0 / 0 | 9 156 / 9 156 kB, 9 104 / 9 104 kB | 1 |
| vNext, Flow on, 1 scheduled workflow, round 1 / 2 | 0 / 0 | 9 284 / 9 284 kB, 9 288 / 9 288 kB | 1 |

Reading: in every state the daemon used less than one clock tick in 45 s (below 0.022 % of one core), so this method cannot
separate "Flow off" from "Flow on" in CPU; it only shows that neither costs a visible amount while idle. Resident memory is
about 9.1 to 9.3 MB for vNext against 8.9 to 9.0 MB for the 1.5.9 binary, roughly +0.2 to +0.3 MB; Flow on or off, with or
without a scheduled workflow, moves it by less than 0.2 MB, which is inside the difference between two starts of the same
binary (9 196 vs 9 220 kB). An earlier 2 to 3 s smoke run gave one tick for "Flow on, 0 workflows"; the 45 s runs did not
reproduce it, and it is within the tick resolution.

## Caveats (what these numbers do not say)

* **Nested is not a real desktop.** The headless shell has one virtual 1280x720 monitor, no real compositor load, no real
  windows, no GPU. Extension load on a real session (with 8 Niro extensions, other users' extensions, a real dconf, a
  real Wayland session) will be slower and noisier than here.
* **The island extension was not running**, so the daemon was idle for real reasons: no app-usage reports, no media, no
  system-state polling from the shell. The idle numbers say what the daemon costs when nothing talks to it. The app-focus
  trigger of Flow (fed by those reports) and the UPower / NetworkManager triggers were not exercised. No real system
  D-Bus events were generated.
* One machine, one kernel, one shell version (GNOME 51.1); 12 CPUs, and the machine was in use for other work during the
  runs. 200 and 60 samples characterise the median; they do not characterise rare slow calls. No confidence intervals.
* The idle CPU resolution is one tick (0.022 % of one core over 45 s); "0" means "below that", not "zero".
* Baseline and vNext were measured one after the other, not interleaved; the baseline extension is the installed
  `1.5.9-939` package, while the vNext tree is uncommitted and moved while it was being measured (other people were
  editing `shell/` and `crates/`). The daemon was rebuilt from the tree at the start of the session.
* Workflow latency measures a one-step, local clipboard action. A workflow with delays, conditions or slow actions is
  dominated by those. Concurrency (up to 4 runs at once), a full history file (200 runs) and a ledger with many events
  were not measured.
* The Search audit log is written inside each `RunAction`, so the 3 ms includes one file append in a scratch folder on a
  fast disk.
* The deb and the rpm were not timed (installation time was not measured).

## Reproduce

```
cargo build --release -p island-daemon && npm run build
bash tests/shell/run-staged.sh e2e-flow-perf                 # vNext
NIRO_PERF_MODE=baseline bash tests/shell/e2e-flow-perf.sh    # the installed package
NIRO_PERF_ONLY_EXT=1 bash tests/shell/run-staged.sh e2e-flow-perf   # extension load only (one cold start per run)
```

`NIRO_PERF_IDLE_SECS`, `NIRO_PERF_ROUNDS` and `NIRO_PERF_N` shorten the run (smoke test: 2 s, 1 round, 30 calls). A full
vNext run takes about 7 minutes (the idle samples), the baseline about 4.
