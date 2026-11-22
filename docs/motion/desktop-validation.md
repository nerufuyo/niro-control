# Desktop validation plan for the motion system

Everything below is **unverified** until someone runs it on a real desktop session and ticks it. The headless runs
(GNOME Shell 51, virtual monitor, virtual input) cover geometry and state, not feel, real input devices or GPU timing.
Record the date, GNOME version, display setup and outcome next to each item. A failed item is a finding, not a retry.

Setup: install the build (`dnf reinstall` if the NVR is unchanged), log out and in, then enable island, dock and search.
To inspect actors use Looking Glass (Alt+F2, `lg`); to watch for errors run `journalctl --user -f -o cat /usr/bin/gnome-shell`.

| # | Scenario | How | Pass when | Result |
|---|---|---|---|---|
| 1 | Island hover, real mouse | Move the pointer slowly onto the closed island, hold 2 s, leave | Expands without a jump, content moves with the surface, no clipping on the first item, collapses after leaving | |
| 2 | Search typing, physical keyboard | Open Search with its shortcut and type immediately, at full speed | Every character lands, none lost while the panel animates, no visible stall | |
| 3 | Result selection and Enter | Arrow through results, press Enter on an app, a setting and a calculation | The app starts at once (not after the fade), selection highlight glides, Enter works on every row type | |
| 4 | Dock magnification | Sweep the pointer along the dock slowly, then fast, then stop and wait | Icons grow continuously, neighbours move aside with no overlap, no flicker at the ends, all settles when still | |
| 5 | Touchpad | Two-finger scroll over the dock and over Search results; three-finger swipe to the Overview and back | No stuck magnification, no stuck Search position, scrolling still works | |
| 6 | Urgency from a real app | Make a real app request attention (for example a chat message, or `notify-send -u critical`, or a terminal bell with urgency) | The icon bounces once, the running mark updates, nothing loops | |
| 7 | Search and Island together | Expand the island (hover), then open Search; then the reverse order | No overlap (12 px gap), Search moves smoothly if needed and returns when the island closes, focus stays in Search | |
| 8 | HiDPI and mixed scaling | Scale 200% and 125%; one monitor at 100% and one at 200% | Gap and positions are the same logical size, no blur, nothing off-screen, spring paths look the same | |
| 9 | Multi-monitor | Two monitors, move the pointer across, open Search on each, plug and unplug one | Search opens on the active monitor and stays inside it; the dock edge activates only on its own monitor; no stale geometry after a hot-plug | |
| 10 | Fullscreen | Fullscreen a video and a game; go to the bottom and top edges | Dock hides and comes back from the edge only; the island stays hidden unless alerts over fullscreen are on; video does not stutter | |
| 11 | Lock and unlock | Lock (Super+L), wake, unlock; also lock while Search or the island is open | Everything returns in a sane state, system docks restored, no leftover overlay | |
| 12 | Repeated disable/enable | Turn each extension off and on 10 times (Extensions app or `gnome-extensions`), also with Search open | No errors in the journal, no duplicated actors, connection counts do not grow (Looking Glass) | |
| 13 | Real GPU frame pacing | Magnify the dock and open/close Search on the native refresh rate (60, 120 or 144 Hz) and film the screen with a phone in slow motion (or use a frame-time overlay if one is available) | No dropped or doubled frames in the spring motion, equal duration at all rates | |
| 14 | Reduced motion | Settings > Accessibility > Reduce animation on | Dock, Search and Island jump with no springs and nothing waits for an animation | |
| 15 | Shell restart / extension reload | Log out and in; on X11 only `Alt+F2 r` | State restored, no half-open surfaces | |

Extra things to watch for while doing the above (write what you see even if nothing fails): any moment the island
content jumps, a frame where the Search input moves, an icon that stays enlarged, anything that keeps animating when idle
(open `top` or `gnome-shell` CPU with the desktop still: it should be near 0 %).

## What the headless runs already covered (do not re-prove, do not over-trust)

Geometry per frame, state paths, disable/enable cycles with no leaks, reduced-motion jumps, 60 and 120 Hz on a virtual
monitor, two virtual monitors for the dock edge. All input was synthetic. See `docs/motion/{dock,search,island,coordination}.md`.
