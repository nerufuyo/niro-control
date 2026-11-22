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

## Verified and not

Verified: `node --test` unit tests; `tsc` and `biome check`; in a hermetic headless GNOME Shell (staged build, 1440x900):
reveal frames at 60 Hz (smooth spring, settles in about 0.35 s, no visible overshoot), state sequence hidden, revealing,
visible, magnifying, hidden; cancelled dismissal; six rapid in/out cycles ending hidden; Gaussian scales with
displacement and no hidden-state scales left; animation switch off makes the dock jump; `disable()` stops cleanly.

Not verified: real pointer motion events (the headless virtual pointer delivered no stage events here, so the pointer state
was fed to the same handler directly); multi-monitor; urgent attention and the running-mark fade; the launch state with a
real app; touchpad and scroll.
