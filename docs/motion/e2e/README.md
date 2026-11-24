# Automated E2E (isolated GNOME 51 session)

Branch `motion-engine`. Everything here is tier **automated-headless-e2e**: a real gnome-shell 51.1 with the real extensions, in a private
headless session, driven by input that enters mutter's seat as a virtual device. It is **not** physical input and **never** turns a
`docs/motion/uat/matrix.md` scenario into Pass. Results: [`report.md`](report.md).

```
npm run build
tests/e2e/run.sh [outdir]          # one fresh session, the 15-scenario suite, report; exit 1 on any Fail/Blocked
tests/e2e/session.sh OUT python3 tests/e2e/poc.py     # the three-scenario proof of concept
```

## Feasibility (what was actually tried in GNOME 51.1 on Wayland)

| Mechanism | Result here | Notes |
|---|---|---|
| **mutter `org.gnome.Mutter.RemoteDesktop` D-Bus API** | **Works, used.** `CreateSession`, `Start`, `NotifyKeyboardKeycode`, `NotifyPointerMotionRelative`, `NotifyPointerButton` | In the private session bus it needs no consent. Events reach the stage (`captured-event` counts), the keybinding for Super+Space fires, Search gets focus and text, the island's `hovered` becomes true, the dock magnifies. `NotifyPointerMotionAbsolute` needs a ScreenCast stream: not tried, relative motion with closed-loop correction is used instead. |
| XDG Desktop Portal RemoteDesktop | Not exercised | Packages are installed (xdg-desktop-portal 1.22, -gnome 51). It wraps the same mutter API and asks the user for consent in a real session; the isolated session has no portal. Whether it works in the real session is therefore untested. |
| libei / EIS (`ConnectToEIS`) | Not exercised | libei/libeis 1.6 libraries are installed, no headers or Python binding; the D-Bus Notify calls above already give a mutter virtual device. A libei path is the next thing to try if per-device capabilities matter. |
| Shell Eval / `Clutter` virtual devices in unsafe mode (the older tests/shell harness) | Works but not wanted here | Needs `--unsafe-mode` (arbitrary JS in the shell). Its `notify_keyval` keys behaved like these (input method path), but it cannot be used without weakening the session. |
| AT-SPI (`python3-pyatspi`) | Not evaluated | The extensions' actors are custom St/Clutter actors; accessibility trees would not show their geometry or state. |
| **Real desktop session** | **Not used** | The same RemoteDesktop service exists on the real session bus (introspected only, never called). Injecting input into the user's live session was deliberately not done. |

**Is injected input equivalent to physical input?** Not proven. What was observed: keys travel the compositor's real event path (keymap,
keybinding, modal grab, input method, key focus) and pointer events produce real enter/leave/motion. What is *not* shown: libinput device
timing, hardware repeat, a physical keyboard's IM behaviour. Keep UAT-SRCH-01..04 physical.

## What the first end-to-end run found

1. **Search never received Enter on GNOME 51.** `ClutterText` takes Return and KP_Enter for its own `activate` signal and emits no
   `key-press-event` for them (Tab, Down, Esc do arrive). Search only listened to `key-press-event`, so Enter never started a result.
   Source is identical at the merge-base, so it is pre-existing, not from the motion engine. The runtime comparison against the packaged
   1.5.9 build was not possible (the telemetry reads 1.6.0 internals); the evidence for "pre-existing" is the unchanged source lines plus the
   same shell behaviour. Fix: `shell/search/extension.ts` also starts the selected result from `activate`, guarded by `canActivateOnReturn`
   (open states only, never while Executing/Dismissing), and `_activate` keeps its `Once` guard. `E2E-SRCH-04` fails without the line
   (observed: Search stays in ResultsExpanded, 0 applications started) and passes with it.
2. The UAT probe hooked `key-press-event` for characters; the input method consumes presses first, so it measured nothing. It now uses the
   entry's `captured-event`.
3. **E2E Search flakiness was the harness environment.** Stock GNOME binds Super+Space to switching input sources, which races with
   Search's default shortcut: Search opened in some sessions and never in others (3/3 runs failing, then 5/5 passing once the session mirrored
   the real desktop's `switch-input-source=['XF86Keyboard']`). Class: environment/harness. Observation for the product: on a stock GNOME with
   two layouts Search's default shortcut collides with the input-source switch; not investigated further.

## Telemetry bridge: `org.niro.E2E` (tests/e2e/telemetry)

Test-only extension `e2e-telemetry@niro.test`; copied only into the session's own XDG_DATA_HOME by `session.sh`, never packaged. Audit
(`tests/e2e/audit_telemetry.py`, run inside the session, 20 checks, all OK):

- inert unless `NIRO_E2E=1` is in the shell environment (verified with `NIRO_E2E_FORCE=0`: loaded but the bus name is never owned);
- exactly five methods (`Ping`, `Snapshot`, `Start`, `Stop`, `Events`), no properties or signals; only `Start` takes a string and it must match
  `[a-z0-9_-]{1,60}` (path traversal, dots, upper case, spaces, empty and over-long names are refused; nothing is written outside `NIRO_E2E_OUT`);
- no code evaluation: `org.gnome.Shell.Eval` is denied in the session (no `--unsafe-mode`); the telemetry reads actors and extension fields, writes none;
- data exposed: pointer, key focus type, modal count, geometry/state of the three components, the **Search query text**, counts of input
  events. Nothing else (no clipboard, files, notifications, credentials, settings values);
- teardown: 5 disable/enable cycles release and re-own the bus name each time; after the last disable no object remains; session-wide 0 shell log errors.

Limits: the session bus is private, so "any process on the bus can call it" means test processes only. If someone enabled the extension in a
real session with `NIRO_E2E=1` it would expose the above to every client of that bus; the guard is the environment variable and that nothing
installs the extension. It reads private fields of the three extensions (`_box`, `_sm`, `_controller`, `_dockManager`), so a refactor there
breaks the telemetry, not the product.

## Coverage (see report.md for per-run results)

Search: open/close/focus restoration, rapid typing, arrow navigation, Enter once (double Enter), Enter while opening, Enter while closing, 10
interrupted cycles. Dock: edge reveal, auto-hide, hysteresis, magnification, neighbour overlap, settling. Island: hover expand/collapse, content
cut ≤ 3 px, interrupted hover. Cross: Search over an expanded island (12 px gap, focus), hovering the island while Search is open. Reduced
motion for Search. Lifecycle: 3 disable/enable cycles per extension.

Not covered: Island voice/peek/alert/split, delayed *slow* results (results arrive within the poll), real application urgency, reduced motion
for Dock/Island, multi-monitor, HiDPI, lock/unlock, physical devices, GPU frame pacing (the headless monitor is a timer, not a GPU).
