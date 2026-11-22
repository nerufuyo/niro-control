# Island motion

Audit of the Dynamic Island's motion and what the unified motion system changed. Files: `shell/island/src/{island,controller,spring,motion,surfaceMotion}.ts`, shared engine `shell/shared/motionEngine.js`.

## What exists

One actor, `Island` (island.ts), is the surface. It has four springs (width, height, radius, shoulder) driven by a `SpringDriver` on a `Clutter.Timeline` that runs only while a spring moves. Views (compact, peek x2, expanded, voice) live inside it and cross-fade (`_showView`); nothing is destroyed or replaced during a morph. The surface hangs from the top edge: only height and width are animated, never y.

Controller `_render()` picks a presentation: `voice` > `expanded` > `peek` (an alert) > `compact`, sizes the view and calls `island.morph(size, view)`.

### States (as implemented)

| Presentation | Surface state | Notes |
|---|---|---|
| (auto-hidden / nothing shown) | idle | `setAutoHidden` lifts the layers, separate from the springs |
| compact | compact | the pill: clock, now-playing, indicators |
| peek | compact | an alert shown in a peek view; routine and critical ones differ only in duration/glow |
| expanded | expanded | the pages |
| voice | immersive | the assistant |
| none | split | **no runtime trigger exists**: one view is shown at a time |
| (leaving) | dismissing | machine state only; the runtime leaves via compact or auto-hide |

### Transition paths

Any presentation can follow any other (`_render` is re-entrant and idempotent). Interruption is a retarget: `Spring.setTarget` keeps velocity. Cross-fade views slide in the direction of growth (`VIEW_SHIFT`), fades via `dur()`.

### Existing animation code and conflicts

- `spring.ts` had its own copy of the spring physics; it duplicated the engine. Now `Spring` extends the shared engine's (same constants: k=155, c=18 for size, 155/25 for radii, rest 0.25 px / 2 px/s). The frame clamp is 0.1 s instead of 0.25 s after a stall.
- Width and height always moved at once, so expansion was a diagonal. Now width leads when growing in both axes and height leads when shrinking.
- Volume/brightness OSD: key repeat called `peek.setAlert` per event. Now coalesced.
- `nudge()` (rubber band at 0 or 100 %) adds width velocity, not a surface bounce on ordinary changes. Kept.
- Reduced motion: `motionOn()` false (preset `off`, or GNOME animations off with a preset) resets the springs and uses `dur() == 0`; this is the instant path. The critically damped path (`morphPlan` with `reduced`) exists for a future "reduced but not off" mode and is not reachable from the current settings.
- Not changed: `spring.ts`'s `SpringDriver` frame clock, `motion.ts`, view cross-fades, `compact.ts` and `expanded.ts` content (their reveals still use the fixed fades).

## What changed

New `surfaceMotion.ts` (pure, no Clutter/GLib):

- `createSurface()`: the `Machine` with states idle, compact, expanded, immersive, split, dismissing. Every live state can be interrupted into any other; `dismissing` reaches `idle` only on `settled`; unknown events are ignored. `surfaceStateFor(presentation)` maps the controller's names.
- `axisOrder` / `morphPlan(from, to, {reduced, off})`: which axis leads, the lagging axis' delay (`AXIS_LAG_MS`, 70 ms), the springs (via `springFor('island')`). `off` gives `instant`.
- `revealDelays` / `MUSIC_REVEAL`: staggered reveal timing from `staggerDelay`; reduced gives zeros.
- `alertMotion`: routine alerts and volume are critically damped; critical ones use the snappy spring.
- `Coalescer`: leading-edge apply, then one trailing flush per 33 ms.

Wiring:

- `island.morph()` calls `morphPlan` with the current visual size; the lagging axis is held at its current value and retargeted by a `GLib` timeout stored in `_axisLag`, cancelled by the next morph and in `_onDestroy`. First show and motion-off skip it.
- `controller._postOsd()` goes through `Coalescer`; the trailing flush uses the controller's `_later('osd-flush')`, which `destroy()` clears. The existing alert timer still dismisses after inactivity (OSD_DURATION 1.5 s).

## Not done

- Split activity has no runtime path (machine only).
- Staggered reveal of artwork, metadata and controls is computed (`revealDelays`) but not applied to `compact.ts`/`expanded.ts`.
- `alertMotion` is not yet applied to the peek view.
- The machine is not the source of truth for `_presentation`; it mirrors it in tests only.
- No visual or runtime verification was done. Tests: `tests/island/islandSurface.test.js`.
