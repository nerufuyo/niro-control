# Island motion

How the Dynamic Island moves, on the unified motion system. Files: `shell/island/src/{island,controller,compact,peek,spring,motion,surfaceMotion}.ts`, `shell/island/src/pages/media.ts`, shared engine `shell/shared/motionEngine.js`.

## One surface, one machine

`Island` (island.ts) is the one actor. Four springs (width, height, corner radius, shoulder; the engine's `Spring`, constants in spring.ts) are stepped by a `SpringDriver` on a `Clutter.Timeline` that runs only while one moves. The views (compact, two peeks, expanded, voice) live inside it and cross-fade; nothing is created or destroyed during a morph. The surface hangs from the top edge: width and height animate, never y.

The controller does not keep a presentation of its own. `SurfacePresenter` (surfaceMotion.ts) owns the `Machine`; `_render()` hands it what the controller knows (assistant open, pages wanted, an alert, how many activities) and **`_presentation` is a getter derived from the machine's state**. Every change of state goes through `_onSurface`, which keeps the last 64 transitions (`_surfaceLog`) for the runtime checks.

| Machine state | Presentation | When |
|---|---|---|
| `idle` | compact / peek (still holding its view) | auto-hidden and settled |
| `compact` | `compact`, or `peek` while an alert shows | the pill; an alert is the same surface showing something else |
| `split` | `compact` | the closed island holds two or more live activities (below) |
| `expanded` | `expanded` | the pages |
| `immersive` | `voice` | the assistant |
| `dismissing` | as before | auto-hide's slide into the edge, from `compact` or `split` |

Precedence: assistant > open island > an alert (it waits behind the open island) > split > compact. Any live state may be interrupted into any other. `dismissing` reaches `idle` on the island's `auto-hide-settled`; while hidden, a render that still wants the compact surface does not undo the dismissal, and un-hiding retargets from wherever the surface is.

## Geometry

`island.morph(size, view, {spring})` asks `morphPlan` for the choreography and names the springs on **every** move (so an alert's spring never lingers):

- Growing in both axes: width first, height after `AXIS_LAG_MS` (70 ms); shrinking: height first. The lagging axis is held at its current value and retargeted by a timer (`_axisLag`) that the next morph or destroy cancels.
- Retargeting keeps position and velocity (`Spring.setTarget`). Interrupting an expand with a collapse never restarts from rest.
- Size spring: k 155, c 18 (about 3.3 % overshoot, the island's elastic personality). Radius and shoulder: critically damped.

### Motion modes (`motion.ts` `motionMode()`, `surfaceMotion.ts` `motionModeFor`)

| Mode | Reached by | Shape | Content |
|---|---|---|---|
| full | preset `default`, `smooth`, `dynamic`, `cinematic` | elastic spring, axes in turn | staggered |
| reduced | preset `minimal` | **critically damped, both axes together, no overshoot** | all pieces at once |
| off | preset `off`, **or GNOME's "reduce animations"** | instant, no spring runs | no fades or slides |

Why `off` stays instant for the system switch: GNOME's switch turns animations off for the whole shell; an island that kept resizing would be the only thing moving. The calm path is for a user who still wants motion but gentler, and the `minimal` preset (already tuned near critical damping in `MOTION_PRESETS`) is that choice, so it needs no new setting. `dur()` and `motionOn()` are unchanged for every other site.

## Content that moves with the shape

Order is always shape first, then content (the reveal waits `FADE_IN_DELAY`/`REVEAL_AFTER_MS`, about 90 ms, for the shape to make room), and the reverse on the way out. All delays are the engine's `staggerDelay` (28 ms a step, capped at 160).

- **Music page** (`pages/media.ts`): cover, title and artist, progress, controls rise 8 px into place in that order when the page opens and when a track starts. When the track goes (player closed), the pieces leave in the reverse order (controls first, cover last), each from wherever its own reveal had got to, and only then does the empty page fade in. A track returning mid-retreat turns the pieces round from where they are (`fromCurrent`), no restart from nothing.
- **Closed island** (`compact.ts`): a new sign fades in after its predecessor's step (the first activity's sign at once, what goes with it one step later). A sign that leaves fades out as a `Clutter.Clone` ghost (140 ms) while the slot is already given to what comes next, so the width follows at once and the sign does not vanish with it.
- **Peek** (`peek.ts` `reveal()`): a critical alert's badge, words and trailing value come in in turn. Routine alerts and the volume do not stagger.

### Split

Two activities coexist when the compact view lists at least two of recording, call, music, timer (`CompactView.activityCount`; the same list it already used to put the first on the left and the next one's sign on the right). The common real pairs are music with the focus timer, a call with music, a recording with music. When the count crosses two the view emits `activities-changed`, `_render` resolves `split`, and the island widens like any other morph. The second zone's sign waits `splitRevealDelay` (axis lag + one step, about 98 ms) so it fades into room the shape has already made; in reduced or off mode there is no wait. The first sign is never touched.

### Alerts by priority

`alertMotion` picks the size spring per alert and the controller passes it to `morph` (and to the copies on other displays): a critical (`priority: 'instant'`, not `transient`) alert uses the snappy spring and reveals its pieces; a routine one is critically damped; the volume/brightness OSD (`transient`) is critically damped and never bounces the surface. `nudge()` (the rubber band at 0 or 100 %) is unchanged.

### Volume bursts

`_postOsd` goes through `Coalescer`: the first event applies at once, the rest within 33 ms are held and only the newest is applied by one trailing flush (`_later('osd-flush')`, cleared by `destroy()`).

## Verification

Pure, `npm test`: `tests/island/islandSurface.test.js` (machine, plan, springs, coalescing) and `islandPresenter.test.js` (presenter, auto-hide, motion modes, reduced path, split delay, alerts, and source checks that the controller, island, compact view, music page and peek really use them).

Runtime, a hermetic headless GNOME 51 with this checkout's island, own HOME/XDG/runtime dir/D-Bus (`tests/shell/island-session.sh <steps> [outdir]`; needs `npm run build` and the installed `island-daemon`):

| Steps | Checks |
|---|---|
| `island-steps-motion.sh` + `island-motion.py` | geometry every frame through compact, expanded, immersive, split, dismiss; the springs' value and velocity read in one call before and after each retarget (identical); no frame off its own velocity; width leads growing, height leads shrinking; overshoot about 3.3 % |
| `island-steps-content.sh` + `island-reveal.py` | split zone wait, music reveal order, reverse retreat, retreat turned round, ghost fade, alert spring and reveal by priority, 60 volume events applied as 17 |
| `island-steps-reduced.sh` | full / minimal / off / GNOME animations off: overshoot, axis order, stagger, instant |
| `island-steps-lifecycle.sh` + `island-lifecycle.py` | disable and enable five times with something live each time (the last mid-morph) |

Limits of the headless runs: the virtual pointer cannot hover the island (the Search entry sits on top), so the island is opened and closed with `controller.expand()` and `collapse()`, which is what a hover calls; screenshots come from a service that lags the action by a few hundred ms, so frame-level evidence is the recorder, not the screenshots; the lifecycle census counts GLib timeouts made through `GLib.timeout_add` and signals connected through `GObject` on the shell's long-lived objects (stage, display, window manager, workspaces, `global`, `St.Settings`, layout manager, overview, message tray, session mode), not signals on JS-signal objects or on the extension's own actors (those die with it).

## Known limits

- When the island widens, the existing first sign sits at its new, wider place at once and is clipped by the shape's edge for the first ~100 ms; the new signs fade in after it, the existing one does not move with the edge (pre-existing: compact keeps its clock still and the views stay still on screen while the shape grows around them).
- The `Clutter.Clone` ghost of a leaving sign is drawn in the place the sign had in the compact view; it is not tracked if the layout moves under it in the 140 ms.
