# Search overlay: motion audit and design

Files: `shell/search/extension.ts` (the actors), `shell/search/searchMotion.ts` (pure state machine, springs and update rules),
`shell/shared/motionEngine.js` (Spring, Animator, Machine, springFor, staggerDelay), `tests/island/searchMotion.test.js`.

## Before (what the code did)

- **Open** (`_open`): `pushModal`, position at 16% of the monitor height, `set_text('')`, `box.show()`, `_refresh()`, `grab_key_focus()`.
  No animation at all: the panel appeared fully drawn. Focus was already immediate.
- **Close** (`_close`): disconnect the outside-click handler, `popModal`, `box.hide()`, clear the per-moment caches (files, net, procs, contents).
  Called by Esc, outside click, toggle, `_snip`, `_activate` and `disable()`.
- **Results** (`_refresh`, on every `text-changed` and on every late async answer): `destroy_all_children()`, rebuild all rows,
  `_select(0)`. Two consequences: a late answer (exchange rate, `find`, definitions/translations, process list) reset the selection to row 0
  and lost the scroll offset, and rows popped in with no transition.
- **Selection** (`_select`): `row.set_style(...)` on every row, instantly; manual scroll fix-up.
- **Execute** (`_activate`): `Once.begin()`, `_close()`, then `await this._run(...)`. Activation was never blocked by an animation (there was none).
- **Animation usage:** none (`grep ease\|add_transition` finds nothing in search). Timers: rate/web fetches, `find`/`grep` children with a 4 s
  kill timer, adaptive live timer; all removed in `disable()` through their owners.

## After

### State machine (`SEARCH_TABLE`, built on shared `Machine`)

States: Closed, Opening, Ready, ResultsExpanded, Executing, Dismissing. Events: open, settled, results{count}, execute, dismiss, close.

| from | events |
|---|---|
| Closed | open -> Opening |
| Opening | settled -> Ready or ResultsExpanded (by count); results -> ResultsExpanded; execute -> Executing; close -> Dismissing |
| Ready | results -> ResultsExpanded/Ready; execute; close |
| ResultsExpanded | results (count 0 -> Ready); execute; close |
| Executing | close/dismiss -> Dismissing; open -> Opening |
| Dismissing | settled -> Closed; open -> Opening (interrupts the fade) |

Unknown events keep the state, so nothing can wedge it. `_live()` (Opening, Ready, ResultsExpanded, Executing) replaces the old
`this._box.visible` checks: an async callback that lands while the panel is only fading out no longer rebuilds the list.

### Opening
`_open` does exactly what it did (grab, position, text, show, refresh, `grab_key_focus`) and then starts `SearchMotion.open()`. Focus and typing
are therefore available on the first frame; `text-changed` keeps working while the panel springs in. The pose is derived from one spring
`panel` 0..1 using `springFor('search')` (critically damped, no overshoot): opacity 0..255, scale 0.97..1 about the top-centre pivot,
`translation_y` -8..0 px. Only transform properties move, never layout, so the input never shifts after the first frame.

### Results
The box is top-anchored; the list grows downward, the input row never moves. Rows reveal with `rowReveal(reveal, i)`: opacity and a 4 px
slide, start offset from `staggerDelay(i)` (28 ms steps, capped at 160 ms), first 8 rows only. The reveal is one spring, not one per row.
`planUpdate` decides, after each rebuild:
- new query text: select row 0, reveal all rows;
- late answer for the same text: select the same result by identity (`resultKey`), reveal only rows that were not there, restore the scroll
  offset (`anchoredScroll`: the selected row is put back at the same place in the viewport, measured after a synchronous allocation, see below).
Empty: the existing status line; while a currency rate is in flight it says "Looking up the exchange rate...".

### Selection highlight
One highlight spring per active row (`SearchMotion.highlight`): old row fades 1 -> 0 while the new one fades 0 -> 1 (alpha 0.28 of the accent).
A rebuilt list lights its row at once (no replay).

### Execution and dismissing
`_activate`: `Once.begin()`, `sm.send('execute')` (the row stays lit as the acknowledgement), `_close()` which releases the modal grab and the
per-moment caches immediately and starts the fade, then `_run` is called in the same tick. Nothing waits on the animation. Escape and
outside click go through `_close()`; toggling while Dismissing re-opens (the spring keeps its velocity and reverses).

### Reduced motion and idle cost
`St.Settings.enable-animations` false -> `springFor(..., {off: true})` returns null and every spring jumps (`reset`), no frame source is created.
The spring is already critically damped, so reduced motion has no overshoot either way. Frames come from a `Clutter.Timeline` attached to the panel (`_wakeFrames`), i.e. the stage's own frame clock, that exists
only while the Animator is active and is stopped when everything is at rest (`onSettled`). A 16 ms `GLib.timeout` was used first and measured badly:
it beats against the 16.67 ms frame clock, so 9 of 164 painted frames (5.5%) had no motion step (a frozen frame) or two (a skipped step); with the
timeline every one of the 163 painted frames had exactly one step.
`disable()` calls `_release()`, `motion.cancel()`, stops the timeline, and destroys the box.

## Interactions with known audit items (not fixed here)
- `_activate` holds `Once` across `await this._run`; reopening during a slow action works visually but Enter is refused until it ends.
  Unchanged; the machine does not depend on `Once`.
- `confirm()` hanging if `dialog.open()` fails: the panel is already dismissed before `_run`, so a stuck dialog no longer leaves a visible panel;
  the Once lock behaviour is unchanged.
- `find` spawned per keystroke: `_refresh` still calls `_findFiles` as before; late file results now keep the selection instead of resetting it.

## Scroll after a late answer
`_refresh` rebuilds the list, and until the next frame `adj.upper` and every row's allocation are those of the old layout (measured: `upper` 952 right
after the rebuild, 1128 a frame later). The first version clamped the restored offset against that stale `upper`, and kept the same offset, so rows arriving
*above* the selection pushed it down the list (a real `find` answer put six Files rows first: the selected row went from 298 px to 624 px in a 354 px viewport,
i.e. out of sight). Now `_keepScroll` records where the selected row sits in the viewport before the rebuild, calls `allocate()` on the scroll view with its
own box (synchronous, no frame wait) so `upper` and the rows are current, and sets `anchoredScroll(newRowY, anchor, upper, page)`.

## Runtime evidence
`tests/shell/search-motion.sh` (needs `npm run build`; headless shell in its own D-Bus session, HOME, settings and Wayland socket via `search-session.sh`)
runs `tests/shell/search-motion.js` inside the shell and asserts: focus on the first frame; keys typed during the opening land in the entry (real virtual
keyboard); no overshoot, monotone, converges; one step per painted frame; frame source stopped at rest; Escape (real virtual key) dismisses and releases the
grab within 60 ms; late rows above and below keep the selected result at the same viewport position on every painted frame; 20 rapid toggles keep the
invariants (no live panel without the grab, no grab without a live panel, never Closed and visible); Escape and Enter still work after them; Enter reaches the
action 1 ms after the key while the fade takes about 450 ms; reduced motion jumps with no frame source; disable/enable x5 and disable while animating leave no
GLib sources, shell-object signal handlers, modal grabs, D-Bus names or actors; the shell log holds no errors from the extension.
One screenshot sequence (spring slowed to about 2 s so it can be caught mid-flight) is in `docs/motion/evidence/search/open-sequence.png`.

## Limits of that evidence
- Input is synthetic (`create_virtual_device`), never a real keyboard or pointer. In a headless session the virtual keyboard's Return is swallowed by the
  input-method filter, so Enter is delivered by calling the key handler with an event object; Escape, Down and letters do go through the virtual keyboard.
  Letters reach the entry asynchronously through the input method.
- Outside-click dismissal and row clicks were not exercised.
- The software renderer's frame pacing is 60 Hz; a 120/144 Hz monitor was not tried (the spring uses fixed sub-steps, so the path is the same by construction).
- Each keystroke rebuilds the list (8 to 12 ms for 15 rows here), so a key typed during the opening can cost one late frame (a 56 ms paint gap was seen with
  three keys in 45 ms). The motion itself catches up (one step per frame, `MAX_FRAME` caps the catch-up).
- Known and unrelated: GJS logs a `Gio.DesktopAppInfo has been moved` deprecation warning once (`Gio.DesktopAppInfo.search`), and mutter logs
  `Overwriting existing binding of keysym 20` on each enable.
- After the panel closes one highlight spring (target 1, at rest) stays in the map until the next open clears it; harmless.
