# Dock motion

How the dock (`shell/dock`) moves, what was found when it was audited, and what changed. The shared physics lives in
`shell/shared/motionEngine.js`; the dock's own pure logic in `shell/dock/src/lib/dockLogic.ts`
(tests: `tests/island/dockLogic.test.js`).

## Before: states and transitions

There was no state machine, only flags in `dockVisibility.ts`: `_shown`, `_overviewHidden`, `_dragActive`, `_alwaysHide`, an
animation source id and a pointer poll. Effective states: hidden, sliding in, shown, sliding out. Magnification and launch
bounces were separate and not known to the visibility code.

Transitions: edge-activator enter or motion, or the stage pointer in the edge zone, shows the dock; a 120 ms debounced check
hides it once the pointer is outside the edge zone, the dock bounds and any popup; a 250 ms poll runs while shown (full-screen
apps send no motion).

## Before: animation code and conflicts

| Where | What | Problem |
| --- | --- | --- |
| `dockVisibility._animateVisibility` | 16 ms `timeout_add`, quadratic ease, time based | not frame-clock aligned (jitter), a retarget restarted from the current position with zero velocity, ran on a timer, kept going with no one watching |
| `magnification.ts` | per-icon damped spring + Gaussian + own sub-stepping | worked, but duplicated the engine's physics; `get_transformed_position` for the container and every icon on every frame |
| `dockManager` ~119 | 8 `notify::*` handlers each calling `_syncBg` | translation-x/y and opacity change every slide frame: 3+ syncs per frame |
| `dockVisibility._isPointerOverDockActor` | `get_actor_at_pos` on every stage motion | a pick per motion event wherever the pointer is |
| `_isPointerInEdgeZone` | only the edge coordinate; no range along the edge | a second monitor, or a pointer past the monitor end, counted as "at the edge"; no hysteresis, so a pointer on the boundary toggled show/hide |
| `iconManager._bounce` | four chained `ease` calls | repeated bounces stacked on each other during rapid app switching |
| `iconManager._refreshRunningIndicator` | `remove_all_children()` then new dots | does not destroy: leaked one actor per mark per focus change; marks popped in with no transition |
| everywhere | no check of the desktop's animation switch | reduced motion ignored |
| urgent windows | nothing | no attention feedback |

## After

States (`dockLogic.ts`, `nextDockState`): hidden, revealing, visible, magnifying, launching, dismissing.

```
hidden --reveal--> revealing --settled--> visible --magnify--> magnifying
visible/magnifying --launch--> launching --launched--> visible | magnifying (pointer still on icons)
revealing/visible/magnifying/launching --dismiss--> dismissing --settled--> hidden
dismissing --reveal--> revealing            (cancelable dismissal)
```

Unlisted events keep the state. `DockVisibility` dispatches reveal/dismiss/settled; `Magnification` reports activity
(`setOnActivity`); `DockManager` reports launch start and end around its bounce.

- **Reveal/dismiss**: one `Spring` (0 = off the edge, 1 = resting) stepped from a `Clutter.Timeline` on the dock's actor
  (frame clock). The timeline exists only while the spring moves. A dismissal cancelled halfway reverses with its velocity.
  In: `snappy` (small overshoot, the playful part); out: critically damped (never bounces). `animation-duration` still
  applies: it scales the spring in time (`springTimeScale`, 200 ms is the reference), and 0 jumps.
- **Edge zone**: bounded to the monitor on both axes (`pointerOnMonitor`), with hysteresis (`edgeThresholds`: leave is
  deeper than enter) through the engine's `edgeHysteresis`.
- **Magnification**: `gaussianScale` for the target, one engine `Spring` per icon (same constants as before). Neighbour
  displacement and stable bar growth are unchanged and still prevent overlap. The hump height comes from icon geometry
  (`riseAbove`), not `get_transformed_position`.
- **Cost**: background sync coalesced to one per main-loop turn (`GLib.PRIORITY_HIGH` idle, before the redraw); actor pick
  only when the pointer is near the dock (`pointerNearDock`). No loop runs at rest: the slide and magnification timelines stop
  themselves; the 250 ms poll still runs only while shown.
- **Feedback**: a bounce cuts the previous one short; running marks are reconciled (no leak) and fade in; a window that
  demands attention or is marked urgent bounces its icon once (not when focused).
- **Reduced motion**: `St.Settings.enable_animations` false makes the slide and magnification jump and skips bounces and
  fades.

Cleanup: `stop()`/`disable()` stop the slide timeline, the coalescing source and the existing sources; signals go through
`SignalManager`.

## Lifecycle fix

`SignalManager.disconnectAll()` at `disable()` raised "already disposed" when a connection was on an actor that had been destroyed
meanwhile (the apps button, stacks, minimized thumbnails): GJS throws on any call on a disposed object. Reproduced on the
merge-base build as well, so it predates the motion work (`motion-engine` does not touch signal handling in `iconManager.ts`). The
same audit found that `_reload()` used `remove_all_children()` and `_doWindowChange()` used `remove_child()`: icons were detached
but never destroyed, and their button-press, button-release and notify::hover handlers stayed connected (their closures keep the
icon alive): 66 connections grew to 180 after twelve favorite-apps changes. Now `_reload()` uses `destroy_all_children()`, the
removal in `_doWindowChange()` destroys the actor, and actors connect through `SignalManager.connectActor()`, which forgets that
actor's connections when it emits `destroy` (and `disconnectSource()` lets an owner let one go earlier, as the download monitor
is). After twelve changes the count is flat (27 then 23). Unit tests: `tests/island/dockSignals.test.js`. Also: keybindings are
removed only if they were added (mutter warned five times per disable otherwise).

## Verified and not

Runtime harness: `tests/shell/dock-session.sh <built dock dir> <steps> <outdir>` starts a hermetic headless GNOME Shell 51 (own
HOME, XDG dirs, XDG_RUNTIME_DIR, D-Bus session, key-file settings, wayland socket; only the dock enabled) and sources a steps
script: `dock-lifecycle-steps.sh`, `dock-motion-steps.sh` (probes in `dock-helper.js`), `dock-multimon-steps.sh`, `dock-hz-steps.sh`;
`dock-analyze.mjs` checks the dumped icon geometry against the engine. Virtual input is the compositor's own virtual pointer
(`create_virtual_device(POINTER_DEVICE)` plus `notify_absolute_motion` with monotonic timestamps). Stage motion events DO arrive
from it (the stage's motion-event count rose one for one with the moves); the one quirk is that the first move of a fresh device
lands at y=0 (hot corner opens the Overview), so the pointer is primed and `Main.overview.hide()` called. All pointer-driven
results below are therefore REAL input events unless marked SYNTHETIC. Only the dock itself is not exercised through
input for: urgency (`Meta.Window.set_demands_attention()` called from the shell; the dock reacts to the same display signal, but
no client sent a hint) and fullscreen (`make_fullscreen()` on a real app window).

Measured (1920x1080, icon size 60, scale 1.4): edge zone enters at 25 px (hidden at 26, shown at 25), 50 crossings of the boundary
gave no show/hide event once shown and d=35 stayed shown (leave is 37); auto-hide dismisses 121 ms after the pointer leaves and is
hidden 505 ms after; reveal settles in 267 ms, overshoot 0.04 px; a dismissal cancelled at slide 0.80 turned around with its
velocity (-8.2/s) and ended visible; scales match `gaussianScale` exactly at six pointer positions and no two icons overlap (gap
6 px at rest spacing, 6 px minimum per painted frame during a sweep); sweeps of 4 laps of 600 ms across the dock at about 125 events
per second: 60 Hz frame mean 16.67 ms (max 20.0), 120 Hz mean 8.33 ms (max 10.6), no dismiss, opacity never below 255 while over the
dock; a real click on the Calculator icon gave launching, bounce to -28 px, and back to magnifying when the window arrived; an
unfocused window demanding attention bounces its icon to -28 px, a focused one does not; with a full-screen window the dock is
hidden, the bottom edge brings it back (scanout held while it is up) and it leaves again; with `enable-animations` off reveal and
settle land in the same frame and the bounce is skipped; disable/enable five times with apps open left the shell log without
errors or warnings; two virtual monitors (1920x1080 and 1280x720): the edge activator and zone belong to the primary monitor, the
pointer at the bottom edge of the second monitor never brings the dock.

Not verified: touchpad and scroll; a client-sent urgency hint; direct scanout (headless has none, only the inhibit flag);
multi-monitor with the dock on a non-primary monitor (the dock only lives on the primary); real GPU frame pacing (virtual monitor).
