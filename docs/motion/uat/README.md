# Desktop UAT: how to run it

Branch `motion-engine`, HEAD `ef887b0`. Nothing here has been run on a desktop: `matrix.md` is empty on purpose.
The checklist of record is `tests/uat/matrix.csv` (42 scenarios, rendered in `matrix.md`); the earlier 15-scenario plan in
`../desktop-validation.md` is covered by it. Everything below is read-only observation plus a reversible install.

## Ground rules

1. **No scenario is Pass without a real desktop run and evidence.** `tests/uat/uat-report.py --check` refuses a Pass without tester,
   date, actual and evidence, and refuses a Fail without class and severity.
2. **No animation parameter is changed because of a number from this UAT.** The headless numbers and the probe numbers are evidence for a
   person to read. A suspicious figure becomes a finding; any retuning is a separate decision, made by you, afterwards.
3. **A failed scenario is a finding, not a retry.** Record it, keep the file, move on. Repeat only to learn whether it is reproducible,
   and write both runs down.
4. **Do not push or open a PR from this phase.** The tool prints "not recommended" until every acceptance criterion is PASS.

## Classifying what you see

| Class | Meaning | Examples | Usual severity |
|---|---|---|---|
| functional | something does not work or breaks input | lost key, stuck grab, extension errors in the journal, app does not start, surface stays open | S1-S2 |
| cosmetic | works, looks wrong | content cut at an edge, 1 px seam, visible jump, a gap of 8 px instead of 12 | S2-S4 |
| performance | works, but late or heavy | dropped frames, input lag against the baseline, CPU not idle after motion | S2-S3 |
| environment | the machine cannot run the scenario, or the tool is at fault | one monitor only, no 200% mode, recorder dropping frames, another extension interfering | Blocked, or Fail with this class |

Severity: **S1** broken or unsafe (crash, stuck keyboard grab, lost input, data loss); **S2** visible defect on a common path;
**S3** minor, rare or subtle; **S4** cosmetic. A result that cannot be told apart from the recorder or another extension is class
`environment` until reproduced without them.

## 0. Before you touch anything

```
cd <repo>
tests/uat/uat.sh preflight          # HEAD, build freshness, what is installed, what blocks scenarios on THIS machine
tests/uat/uat.sh env                # writes ~/niro-uat/env-<time>.txt: attach it to the report
```

`preflight` prints `BLOCKED-ENV` lines for scenarios this hardware cannot run (it saw one 1080p60 monitor at scale 1 here: no
multi-monitor, HiDPI or 120 Hz scenario can run without more hardware). Mark those `Blocked` with class `environment`; do not skip them silently.

Close everything you care about. Keep a second way in: a TTY (`Ctrl+Alt+F3`) or another machine over ssh.

## 1. Baseline on the packaged build (UAT-BASE-01)

Do this before installing: the installed package (1.5.9 here) is what every later figure is compared with. Run the probe recipes of
sections 4 and 5 for Search typing, Dock magnification and frame pacing, and keep the JSON files.

## 2. Install and rollback

```
tests/uat/uat.sh install --dry-run       # shows what would move and be written
tests/uat/uat.sh install --build         # builds (npm run build), copies island/dock/search into ~/.local/share/gnome-shell/extensions
tests/uat/uat.sh status
# log out, log back in (Wayland cannot reload JavaScript in a running shell)
gnome-extensions info dock@niro.local    # Path must now be under ~/.local/share
```

What it does and does not do:

- Writes only under `~/.local/share/gnome-shell/extensions/{island,dock,search}@niro.local` (a copy GNOME prefers over `/usr/share`) and a
  backup folder `~/.local/state/niro-uat/<run>/` (enabled list, `dconf dump` of `/org/gnome/shell/extensions/`, hashes of every file, git HEAD).
- Never uses sudo, never touches `/usr` or the installed package, never enables or disables an extension, never changes settings.
- A user copy you already had is moved into the backup folder and put back by rollback.
- Island's daemon stays the packaged one (1.5.9) while the extension is 1.6.0 (repo `VERSION`): any behaviour that depends on the daemon is
  therefore a mixed-version result. Record it; do not read a daemon-side oddity as a motion defect.

Rollback, in order of drasticness:

```
tests/uat/uat.sh rollback                              # removes the three UAT copies, restores any copy it moved aside
tests/uat/uat.sh rollback --restore-enabled --restore-settings    # also puts back the enabled list and extension settings from the backup
# log out and in
```

Emergency (session will not come up cleanly): from a TTY, `rm -rf ~/.local/share/gnome-shell/extensions/{island,dock,search}@niro.local`, or
`gsettings set org.gnome.shell disable-user-extensions true` (turns off every extension under `~/.local`, the packaged ones keep running), then log in.

Rollback was exercised here only against a temporary data directory (install, status with a modified file, rollback, a pre-existing copy
restored, `--restore-*` as a dry run). It has not run against a real session.

## 3. Recording evidence

Make a folder per run, for example `~/niro-uat/run-<date>/`, and put in it:

| What | How |
|---|---|
| Environment | `tests/uat/uat.sh env` (monitors, scale, refresh, GPU, versions, other extensions) |
| Journal | `tests/uat/uat.sh journal` in a spare terminal during the whole run; it counts `JS ERROR`, `Gjs-CRITICAL`, `TypeError`, `ReferenceError`, `JS WARNING` the way the headless tests do |
| Probe files | written to `~/niro-uat/<time>-<kind>.json` by the probe (below) |
| Screen recording | `Ctrl+Shift+Alt+R` starts and stops GNOME's recorder (writes to `~/Videos/Screencasts`); `tests/uat/frame-pacing.py FILE --hz <rate>` analyses it |
| Phone video | 240 fps slow motion of the screen for typing latency and pacing; note the camera rate |
| Idle CPU | `tests/uat/uat.sh idle 30` with the desktop still |

Write the file names into the `evidence` column of `tests/uat/matrix.csv`, fill `actual`, `status`, `tester`, `date`, then run
`python3 tests/uat/uat-report.py --md docs/motion/uat/matrix.md --check`.

## 4. The in-shell probe (Looking Glass)

`tests/uat/probes/uat-probe.js` is an observer: it connects signals on the stage and on actors found by name or style class, and changes
nothing in the extensions. It needs no unsafe mode. Load it:

1. `Alt+F2`, type `lg`, Enter (Looking Glass opens; use its Evaluator tab or the input line at the bottom).
2. Paste, with the real path:
   `eval(imports.byteArray.toString(imports.gi.GLib.file_get_contents('<repo>/tests/uat/probes/uat-probe.js')[1]))`
3. `__uat.start('search')` (or `'dock'`, `'island'`, `'frames'`). Close Looking Glass with `Esc`: **Search and the keyboard scenarios need
   the keyboard**, so run the scenario with Looking Glass closed.
4. `__uat.mark('what I am about to do')` between steps if you reopen it; otherwise the recording is one stretch.
5. Reopen `lg`, run `__uat.stop()`. It prints the summary and writes the JSON. `__uat.census()` counts actors before and after
   enable/disable cycles. The probe disappears at logout; `__uat.stop()` disconnects everything it connected.

What each kind measures, and what it cannot:

| Kind | Measures | Cannot measure |
|---|---|---|
| `frames` | intervals between the compositor's paints, inside bursts of activity | the time from paint to the panel, or whether a repeated frame looks the same |
| `search` | key-press to text-changed and to the next paint; characters lost; panel pose per paint; gap to the island | kernel/libinput time before the compositor; the input method on other layouts |
| `dock` | per-paint icon scale and position, neighbour overlap, steps per frame, magnification left on after the pointer rests | hardware pointer latency; whether the motion *looks* smooth (read it with the video) |
| `island` | surface rectangle per paint; text/icon leaves cut by its edge; content moving relative to the surface | semantic correctness of what the view shows |

Known limits of the probe itself, to be recorded not hidden:

- Verified headless: it loads, records and stops cleanly for frames, island, search and dock, with 0 shell errors.
- **Search key hook:** headless with mutter RemoteDesktop input, the entry gets `captured-event` for key presses (the `key-press-event` signal never fires there, so the probe uses `captured-event`). Not yet confirmed on a physical keyboard.
- The island `outside`/`jump` figures are indicative. The headless clip tests judged the morph with `outside <= 3` and `jump <= edge + 4`;
  no such reference exists for voice, peek or alert, so judge those with the video.
- A still screen paints nothing: intervals above 100 ms end a burst and are never counted as stalls.

## 5. Scenario recipes (the new ones)

**Island voice, peek and alert (UAT-ISL-02/03/04).** These views do not follow the surface edge frame by frame (a known limit from the
headless work), so this is the first look at them. Start `__uat.start('island')` (mark each step), then:

- Voice: open the assistant, speak, wait for the answer, close. Watch for: the bot icon and text appearing before the surface is wide enough,
  anything drawn past the rounded edge, a frame of the previous view, the shape not returning to closed.
- Peek: change tracks, start a timer. Watch the staggered reveal: pieces should appear in order, not at once, not after the surface settled.
- Alert: `notify-send "Title" "Body"`, then `notify-send -u critical "Title" "Body"`, press the volume keys ten times quickly, plug the charger
  in and out if you can. Watch for the alert text clipped on its first frame and for the volume bar restarting on every key.
- Film each at 240 fps. A teleport is one frame, which the probe may or may not catch: the video decides.

**Search typing (UAT-SRCH-01/02/03).** Physical keyboard only. `__uat.start('search')`, close Looking Glass, then press the Search shortcut and
type `the quick brown fox 12345` with no pause, ten times; then the sustained run with corrections. Reopen `lg`, `__uat.stop()`. Judge:
`lost_characters_estimate` 0, `final_text_length` matches, `frames_without_input_focus` 0, `max_y_step_per_frame_px` small while typing.
Compare `key_to_text_ms` and `key_to_next_paint_ms` with the baseline run; both p95 and max, not the mean.

**Dock magnification under a real pointer (UAT-DOCK-01/02/03).** `__uat.start('dock')`, close Looking Glass, sweep slowly, then fast, then
stop on an icon for 3 s, then leave and wait 3 s. In `stop()` read `max_neighbour_overlap_px` (about 0), `max_scale_step_per_frame`,
`rest_frames_with_magnified_icon` (0), and `pacing_while_moving`. The earlier headless run saw 0 px overlap and max scale step 0.038 per frame with
synthetic events; real hands are the point of this test.

**HiDPI (UAT-HD-*).** Settings > Displays > Scale 200%, then 125%/150% (needs the fractional-scaling experimental feature, note it), then two
monitors at 100% and 200%. Repeat UAT-ISL-01, UAT-SRCH-05 and UAT-DOCK-01 each time with the probes on. Expected gap to the island is 12 logical
pixels, not physical. Look for blur, 1 px seams between icons, anything outside the screen.

**Multi-monitor (UAT-MM-*).** Two monitors; open Search with the pointer on each; sweep the dock edge on each; unplug and plug the second while
Search is open and the dock is shown; take `__uat.census()` before and after. Run `uat.sh env` after each layout so the matrix says what the layout was.

**Frame pacing (UAT-FP-*).** Per scenario: probe `frames` while doing it, plus a screen recording analysed with `frame-pacing.py`, plus the phone video.
Run it once with the recorder on and once without; if only the recorded run drops frames, the recorder is the cause (class environment).
`tests/uat/uat.sh idle 30` afterwards.

## 6. After the run

```
python3 tests/uat/uat-report.py --md docs/motion/uat/matrix.md --check
```

Give back the CSV, the files named in `evidence`, the env file and the journal. The report will say per acceptance criterion PASS / FAIL /
NOT VERIFIED / BLOCKED. Only then does a push or PR recommendation make sense.

## What is not covered even by a full pass of this UAT

Real GPU scan-out timing is only seen through video; touchpad gestures beyond UAT-DOCK-04; X11 sessions; GNOME versions other than the one
recorded in `env`; long-run memory growth beyond the ten enable/disable cycles; the daemon at 1.6.0 (the UAT copy runs against the packaged daemon).
