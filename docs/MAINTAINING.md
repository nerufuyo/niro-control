# Maintaining Niro Control

## How the parts fit

- **`org.niro.control`** (`control/org.niro.control.gschema.xml`) is the one shared setting: tone (`accent`, `tint`),
  `opacity`, `blur`, `blur-strength`, and the search shortcut. The control panel writes it.
- **The island** (`shell/island/src/niroSync.ts`) listens to it and copies it to the other parts' own settings: its glass,
  the dock (`dock-opacity`, `dock-blur-enabled`, `dock-background-color`, indicator colours) and Blur my Shell. It also
  loads a small stylesheet in the accent colour.
- **The search** (`shell/search`) reads `org.niro.control` directly each time it opens.
- **The control panel** (`control/`) builds itself from `control/src/catalog.ts`, which `scripts/control-panel-items.py`
  writes from the schemas (`make catalog`; 200 settings). See "The control panel" below.
- **The island's programs** (`crates/`) are started by systemd (`island-daemon.service`) and D-Bus
  (`org.niro.island.Daemon`, `org.niro.island.ShelfWindow`); `docs/island-dbus-api.md` describes the API.

## Parts kept as they were

`shell/blur`, `shell/corners` and `shell/emoji` are copies of third-party GPL extensions (renamed `blur@`, `corners@`,
`emoji@niro.local`; their schemas keep the original ids so settings carry over). `shell/corners` has two small fixes
(a closing window no longer breaks its refresh). `user-theme` and `appindicator` (and Ubuntu's `tiling-assistant`)
are package dependencies, not copies. Vitals and system-monitor are gone: the island's System page shows
CPU, memory, temperature and network.

## Changing things

| To | Edit |
|---|---|
| add a shared look setting | `control/org.niro.control.gschema.xml`, then `niroSync.ts` (what copies it) |
| add an island or dock setting | its own schema (`shell/island/schemas`, `shell/dock/schemas`): the panel picks it up |
| change a shortcut default | the schema key's default (`search-shortcut`, `shortcut-*`) |
| change which extensions are on, the dock's favourites | `data/dconf/00-niro` |
| change what the package installs or runs | `packaging/build.sh` (stages the files for both), `packaging/debian/*`, `packaging/rpm/niro-control.spec` |

## Types and tests

The island's files start with `// @ts-nocheck`: converted from JavaScript, the build output is token-identical to the
old JavaScript. Remove the comment from one file at a time and fix what the compiler says. The dock is strict already.
`tests/island` run against the compiled island (`shell/island/build`).

## Releasing

Bump `VERSION`, `make rpm` or `make deb`, `make install`. The package version is `VERSION+git<commit count>`. Extensions and the
panel load after logging out and in. The island's update check (this project's GitHub releases, once a day) is on by default and only says where the new version is; nothing is downloaded or run by Island.

## Rust notes

`island-whisper` needs cmake, a C++ compiler, libclang and, for the GPU, the Vulkan headers and `glslc`;
`island-shelf` needs the GTK 4 development files. `make deps` installs them for Fedora and Debian/Ubuntu. The first build compiles whisper.cpp and takes several minutes.

## The control panel

```
control/src/catalog.ts     generated: every setting (key, type, range, default, title, help, group, control kind)
control/src/types.ts       what an item is
control/src/logic.ts       pure: search, dependencies, shortcut conflicts (tested with node)
control/src/store.ts       bindings: one per key, per dictionary field (rounded corners) or per shadow; reset, isDefault, subscribe
control/src/components.ts  SettingsRow, SettingsSwitch/Slider/Stepper/Select/Text, ColorPicker, ShortcutRecorder, ResetControl,
                           SettingsSection, AdvancedDisclosure, SettingsSearch, PreviewPanel
control/src/previews.ts    the drawings (Look, Dock, Windows)
control/src/pages.ts       the Model (bindings, dependencies, conflicts) and the pages
control/src/window.ts      the window: sidebar, search, stack, banner, keyboard shortcuts
```

- **One owner per setting.** Look writes opacity, blur, blur strength, tint and accent; the island, dock and windows copy them
  (`niroSync.ts`). Their copies are shown as "Change in Look", never as a second control.
- **Adding a setting:** add the key to its schema, then `make catalog`. Give it a group in `island_group` / `dock_group` in the
  script if the default grouping is wrong. `make test` fails if the catalog and the CSV drift or a setting has no binding.
- **Dependencies** (a control greyed out while another is off) are the `DEPENDS` table in the script.
- **Looking at it:** `NIRO_PAGE=dock`, `NIRO_SEARCH=blur` and `NIRO_SCHEME=light` open the panel on a page, a search or the other
  appearance (`gjs -m control/build/niro-control.js`).
- **Tests:** `tests/island/controlLogic.test.js` (catalog, search, conflicts), `tests/gjs/controlUi.test.js` (every setting binds,
  writes, reads back and resets against real schemas; with a display, every setting has a row and no raw HTML entity is shown).

## Profiles

`control/src/profileLogic.ts` (pure) and `profiles.ts` (the engine, GJS, no GTK). A profile is a versioned JSON file
(`format: niro-profile`, `version: 1`, `settings: {item id: value}`, optional `extends`). Built-ins ship in
`control/profiles/*.json` (installed to `/usr/share/niro-control/profiles`); yours live in `~/.config/niro-control/profiles`.
A profile may name only some settings (partial). Settings Look owns (`managed`) are never in a profile: their owner is.
Applying makes a backup first, writes Look first, and puts everything back if a write fails. `state.json` holds the active
profile; "modified" is just a diff of the live settings against it. Command line: `niro-control --list-profiles`,
`--apply-profile <id>`, `--current-profile`, `--restore-backup latest`. dconf writes are queued, so the engine calls
`Gio.Settings.sync()` before a short-lived process exits.

## Search and the action registry

`shell/search/registry.ts` (pure) is the one list of what Niro can do: typed parameters (unknown ones refused), availability,
and a permission (`none`, or `confirm`). `actions.ts` holds the handlers; `extension.ts` the palette. `calc.ts` and `units.ts`
are small parsers (no eval). Settings come from `settings-index.ts`, generated with the catalog. Clipboard history is only
searched when the query starts with `clip`. The registry is also on the session bus as `org.niro.Search` at `/org/niro/Search`:
`ListActions()` and `RunAction(id, args_json)`. From outside the palette every action that is not `none` asks on screen first.
A shortcut or script can run one with `gdbus call --session --dest org.niro.Search --object-path /org/niro/Search --method
org.niro.Search.RunAction profile.apply '{"id":"gaming"}'`. The island's assistant (Rust) does not call it yet.

## Home and the two modes

Home (`homePage.ts`) only reads. Simple/Advanced (`Model.setMode`) hides the Advanced groups and shows a hint with their count;
it saves to `ui.json` in the config folder and never writes a setting. Search results show every setting in both modes.

## Settings health and dependency rules

Home shows a Settings Health group (`control/src/health.ts`, pure and tested; `homePage.ts` gathers the facts). A row is healthy only when it was checked: an unanswered question (GNOME Shell did not report extension states, the session bus did not answer) is "unavailable", never a green tick.

A dependency rule in `scripts/control-panel-items.py` (`DEPENDS`) greys a row out when its controlling setting is off. A rule stays only where the extension's code ties the two together; each was audited against the code and the ones with no support were dropped (reasons are in the comment above `DEPENDS`). A rule that is only reasoned from the wiring goes in `UNVERIFIED`: the panel shows it as a hint and it never disables a row or adds a "no effect" note. Adding a rule: find the line of code that reads the dependent setting only when the controlling one holds, then add the rule; if you cannot, add it to `UNVERIFIED`.

## Performance

`scripts/benchmark-performance.sh [--cold] [--quick]` measures the panel, Search, the profile engine and GNOME Shell with and without the Niro extensions, in private headless shells and against throw-away settings, plus read-only samples of your running shell. Reports go to `reports/performance/` (JSON and Markdown, median and p95). The numbers of one machine are a baseline for that machine: compare two runs on the same machine under the same load, never across machines. Search latency is JavaScript time inside the shell, not time to pixel.

## Checks, by kind

- Automated: `npm test` (node and GJS), `cargo test -p island-core -p island-daemon`.
- Headless GNOME Shell: `make test-shell` (needs the installed package).
- Installed files match the build: `scripts/verify-install.sh`.
- Real session: `docs/UAT.md`. Nothing is called verified in a real session until that checklist has been run.

## The panel's glass (layers)

`control/src/appearanceTokens.ts` (pure, tested) defines the panel's look as three layers, and `window.ts` loads its `stylesheet()` at a priority above the user's own `~/.config/gtk-4.0/gtk.css` (that file can carry a whole-desktop GTK theme that would otherwise repaint the panel with opaque backgrounds and a fixed text colour):

1. glass: the window's own background. The only layer that follows Look > Opacity (and the Look tint in the dark scheme).
2. surfaces: sidebar, content, groups, raised things: fixed alphas, high enough to carry text over any wallpaper.
3. foreground: text and dividers: fixed colours. Nothing sets `opacity` on a container; libadwaita's dimming of secondary text (an `opacity`) is replaced by a colour, because opacity over glass dims the text with it.

The shell's blur extension used to fade whole windows by the Look opacity; the panel (`org.niro.Control`) is now exempt (it still gets the blur behind it) because it paints its own glass. That change is in `shell/blur/components/applications/index.js` and loads at the next login.

`scripts/glass-matrix.sh` takes screenshots over four wallpapers, several opacities and both schemes in a private headless shell (it loads the repository's blur extension, not the installed one). `tests/island/glass.test.js` checks that no token but the glass follows the opacity and that primary and secondary text reach WCAG AA over black, white and mid wallpapers at every opacity.

## GNOME Shell 46 to 51

Shell APIs change between versions; the places that differ are kept in one file each: `shell/island/src/compat.ts`,
`shell/dock/src/lib/compat.ts`, `shell/corners/effect/glsl_effect.js`. Known differences: `St.BoxLayout` takes
`orientation` instead of `vertical` (48 added it, 51 dropped the old one); `Shell.GLSLEffect` is gone in 51 (a
`Clutter.ShaderEffect` takes its place; effects define `buildPipeline()`, not a vfunc); `Meta.Window.maximize()` lost its
flags in 49. Test a new shell with a headless GNOME Shell and the extensions copied to a throwaway `XDG_DATA_HOME`, then
read the shell's log for `CRITICAL` lines: a missing property only shows when the extension is enabled.
`blur` and `corners` are the least tested on 51 (they load and enable; their drawing needs a real session).

## Overview (Super)

The dock and the closed island step out of the Overview: the dock slides off its edge and fades (`DockManager._setOverviewHidden`, or `DockVisibility.setOverviewHidden` while auto-hide is on), the island uses its auto-hide (`overview` in `visibilityRules.autoHide`, hidden at once, no edge brings it back). Both come back as the Overview starts to close (`hiding`, not `hidden`). Alerts and the open island stay.

## Full-screen apps

GNOME hides chrome under a full-screen window and gives it no way back; both parts leave that rule on their own terms (setting `fullscreen-reveal`, on by default, in the island's and the dock's schemas).

- **Dock:** auto-hides there whatever its setting; the whole bottom (or side) edge of the screen brings it back, not only the stretch in front of it (`DockManager._syncFullscreen`, `DockVisibility.setFullEdge`). `DockVisibility` polls the pointer while it is up, as no motion event reaches the stage over a full-screen window. A full-screen window may be sent straight to the screen (Wayland's direct scanout, X11's unredirection), past what is drawn over it: while the dock is up over one, `DockManager._syncScanout` holds that back (`inhibitScanout`, counted and paired with the dock's `setOnActiveChanged`), and not otherwise, so a video or game keeps its direct path. This only shows on real graphics hardware; the headless shell has no scanout, so the test counts the calls.
- **Island:** a strip along the whole top edge (`Controller._syncFullscreenReveal`) brings it in; it stays while the pointer is parked at the top edge anywhere, over it, or while it is open. (A strip as wide as the island once flickered: the island went, the strip came back under the still pointer and brought the island again.) The same works from the keyboard: the shortcuts for the clipboard/calendar pages and for the voice assistant bring it in too.
- **What shows over a full-screen app** is the island setting `fullscreen-alerts`: `all` (the default: notifications, music, calls, timers, volume...), `important` (notifications, calls, timers, reminders, meetings, questions from AIs; `_fullscreenImportant`), or `off` (everything waits until the app leaves full screen). What waits is shown when it does. The old `alerts-over-fullscreen` is deprecated and not read.

## Minimized windows in the dock

As on macOS, a minimized window goes to a thumbnail at the dock's right end, after a separator (setting `minimized-in-dock`, on by default; off gives GNOME's own: into the app's icon). `IconManager` owns the thumbnails (`syncMinimized`, `addMinimized`, `removeMinimized`; a `Clutter.Clone` of the window's actor, with the app's icon in the corner), `DockManager._genie` sends the genie to the thumbnail's slot (worked out before it exists: the dock grows around its centre) and back from it on restore, and the dock's size counts them (`getMinimizedExtent`). Only pinned apps get thumbnails at the end; an app that is not pinned has none: its own icon becomes the overview (a window's thumbnail, `_syncOverviewIcons`) while all its windows are minimized, and goes back when one is restored.

## Dock size and icon look

Size: `icon-size` (slider, 16-128), `icon-spacing` and `dock-padding`; the dock's own size is worked out from them in `DockManager._updatePosition` and `_dockHeight`. Icons: `icon-theme` (any installed theme; `iconTheme.ts` looks icons up by the freedesktop rules in that theme and the ones it inherits, and the desktop's own icon is kept where the theme has none), `icon-style` (a tile behind each icon: plain, rounded, circle, glass; the icon is 74% of its slot on a tile), `icon-color` (original, muted, monochrome: a `Clutter.DesaturateEffect`) and `app-button-icon` (six pictures for the applications button). The panel's icon-theme list is read from the computer when it opens (`installedIconThemes`, an item with `dynamic: 'icon-themes'`).

## System notifications, system docks, X11

- **GNOME's own notification banners** are hidden while the island is on (island setting `gnome-banners` off, the default; `notifications.ts` keeps the tray's `bannerBlocked` set); the island shows the notification instead. `gnome-banners` on hands the banners back to GNOME.
- **System docks:** with `hide-system-dock` on (default) the dock turns off Ubuntu Dock and Dash to Dock while it runs and turns them on again when it goes or the setting is off (`DockManager._syncSystemDocks`, deferred: the extension manager must not rewrite its list inside `enable()`). GNOME's own dash in the Overview is always hidden.
- **X11** (GNOME 48 and older, Ubuntu's Xorg session): the island has its own paths (`isWayland()`: input region, screen sharing). A full-screen window on X11 goes straight to the screen, past the edge reveal, so both the island and the dock hold back unredirection (`inhibitScanout`) while a full-screen reveal is wanted. GNOME 49 and later have no X11 session, so none of this has been run on a real Xorg session: it follows Dash to Dock's approach and the island's earlier X11 code. Check it on Ubuntu 24.04 with `docs/UAT.md` under Xorg.

## No top bar (the island alone)

With the island on, GNOME's own top bar is taken away (island setting `hide-top-bar`, on by default; `shell/island/src/barHider.ts`): windows use the whole screen and the island stands alone at the top (`docs/images/island-active.png`). The bar is slid off the screen, not hidden, so its buttons still have a place: Quick Settings on Super+S, the calendar and other extensions' menus open as before. GNOME reserves the bar's room in the work area from its position and size without asking whether it is shown (`LayoutManager._updateRegions`), so the bar is also taken out of the struts (`trackChrome` with `affectsStruts: false`) and put back as it was. In the island's code `_barHidden` is false for a bar this setting took away, so the auto-hide mode "top-bar" does not hide the island for it.

## Controls page (the island's quick settings)

The island's Controls page (`shell/island/src/pages/controls.ts`, shortcut Super+Alt+K) sets what one reaches for in GNOME's Quick Settings. Four views under tabs: **Quick** (the sound, microphone and screen as thick sliders, easy to hit and always showing the level, with the device's name above the first two as a button into Sound; and six switch tiles: Wi-Fi and Bluetooth, each with an arrow into its list, Airplane, Do Not Disturb, Night Light and Dark style), **Wi-Fi**, **Bluetooth** and **Sound** (outputs and inputs, each with its own level). The page keeps its own height (214 px, `minHeight`, which Settings → Size does not shrink): the usual 150 crushed the sliders. The thick slider is `Slider({thick: true})` in `widgets.ts`: an 8 px track, an 18 px knob always shown, a 30 px place to press.

Wi-Fi: the list shows the joined network first, then by signal, each with its state (Connected, Saved, Secured, Open, Connecting…, or why the last try failed). A click joins an open or saved network at once; a new secured one opens a password bar between the buttons and the list (Enter joins, Esc or × cancels; the island keeps the keyboard while it is open). A wrong password says so and keeps the bar, and the connection that try made is deleted, so it is not retried with the same password; a saved network that fails offers Forget. Disconnect leaves the joined one. All of it is `nmcli` (`WifiNetworks` in `systemControls.ts`), the same service as GNOME's; the password goes on nmcli's command line for the seconds the join takes, visible to the same user's processes only. Reads that overlap are numbered so only the newest is applied.

The services in `systemControls.ts` use what GNOME uses, so both always agree: the shell's mixer (`audio.ts`), `Main.brightnessManager` (GNOME 48+) or the settings daemon, GnomeBluetooth, nmcli for NetworkManager, power-profiles-daemon and UPower over D-Bus, rfkill. What the computer does not have (no backlight on a desktop, no Wi-Fi, no Bluetooth) is not shown. The rules that need no GNOME (the Wi-Fi list's parsing, what a failed join means, the battery's words) are in `powerRules.ts`, tested by `tests/island/powerRules.test.js`; `tests/shell/controls.sh` runs both pages in a headless shell, with a stand-in nmcli (`tests/shell/fake/nmcli`) and a battery the test sets. Never touched by tests: sound, brightness and the radios. Not run on real hardware here: brightness (the test computer is a desktop with no backlight), a real Wi-Fi adapter and a real battery.

## Power page and the battery

The Power page (`pages/power.ts`, 196 px tall) has three parts. The **battery card** (only on a computer with a battery): the level big, what it is doing (Charging, On battery, Fully charged, Plugged in · not charging) with the time to full or left, a bar (green while charging, red at 20% or under on battery), and the health (UPower's `Capacity`) and the power in watts. It reads UPower's display device (`Battery` in `systemControls.ts`) and says so only when something it shows changed. The **power mode** card: one button per profile power-profiles-daemon offers (Power Saver, Balanced, Performance), the one in use lit. The **actions**: Lock, Sleep, Log out, Restart, Shut down; the last three go through `gnome-session-quit`, which asks GNOME's own confirmation. The switches that used to be here (dark style, Night Light, the radios) are on the Controls page.

## Session restore (open apps come back after a reboot)

`shell/island/src/sessionRestore.ts`, started by the island controller. The open applications (normal windows of apps that
have a desktop file) and where their windows are (workspace, monitor, size, place, maximized, minimized) are written to
`~/.local/state/niro/session.json` five seconds after the last change. The delay is what keeps a logout from emptying the
file: the apps close one by one as the session ends and the shell is gone before it settles, so the last settled state stays.
At the next login, once (a marker in `$XDG_RUNTIME_DIR` that names the shell process, pid and start time: the runtime directory can outlive a
logout, so the file alone cannot tell one login from the next; a new login is a new shell on Wayland, an unlock or an extension
reload is not), the apps that are not running are started `restore-session-delay` seconds after the session is up, 0.9 s
apart, and their first window is put back (`restore-positions`). Saving stays off until that is done. Settings:
`restore-session`, `restore-positions`, `restore-session-delay`, `restore-session-exclude` (desktop file ids). Tested by
running two headless shells with the same `XDG_STATE_HOME` (`NIRO_RESTORE_MARKER` picks the marker file).

## Dock under maximized and full-screen windows

`hide-when-maximized` (dock, on by default): the dock is up on the desktop and over small windows, and slides away while a
maximized or full-screen window on the dock's monitor covers it; the edge brings it back (`DockVisibility.setAlwaysHide(false)`:
the dock hides only while `_overlap` is set by `Intellihide`). `auto-hide` stays the plain mode that hides whenever the pointer
leaves. `Intellihide` looks again on `size-changed`, `minimize`, `unminimize`, `map`, `destroy`, workspace and full-screen
changes: maximizing restacks nothing, so `restacked` alone missed it. A headless test that checks the dock must keep the
Overview closed (an empty headless shell opens it, and the dock rightly leaves with it).

## Rounded corners on GNOME 51 (Wayland windows)

On GNOME 51 the corners extension did nothing for a native Wayland window (Chrome, GTK apps): `Meta.Window.get_wm_class_instance()` is
null there, so `shouldEnableEffect` skipped it (the window keeps its own corners: for Chrome, rounded on top and square at the
bottom). `windowClass()` in `shell/corners/manager/utils.js` now falls back to the Wayland app id. Two more things only showed once the
effect ran: GNOME 51's `org.gnome.mutter` schema has no `experimental-features` key (reading it threw, so the shader never got its
bounds and the window was clipped to nothing) and `Meta.is_wayland_compositor` is gone; `windowScaleFactor` asks the schema first and
takes the logical scale of 1 on Wayland. Check with a GTK 3 window (square bottom corners of its own) in a headless shell, with
`/run/user/1000/gnome-shell-disable-extensions` removed first (a killed headless shell leaves it, and extensions then do not load).

## Tile (windows in tiles, Hyprland-style layouts)

`shell/tile/` (plain JS, no build step): `layouts.js` is pure (`arrange(layout, count, area, options)` returns one rectangle per window
and is tested in `tests/island/tileLayouts.test.js`), `extension.js` places the windows. It is **off** until `enabled` is set: nothing is moved
before that. Ten layouts: Dwindle, Master left/right, Center master, Grid, Three columns, Horizontal and Vertical split, Scrolling
(columns that do not fit sit behind the nearest one in view) and Monocle. Dwindle is stateless: from the order of the windows, each one takes half of what is
left (the split follows the shape of the space), so it matches Hyprland's on the first windows but does not keep a tree.
Tiled: normal, resizable windows, not minimized, full-screen, transient (dialogs) or on all workspaces (a window maximized before the tiling took it is unmaximized into a tile; one maximized after being tiled stays maximized: `_placed`; `allows_move()` and `allows_resize()` are false for a maximized window, so `resizeable` is what is asked then), and not floated (`Super+Alt+F`)
or in `floating-apps`. The order is the order the windows came in; `Super+Alt+Return` moves the focused one first. The windows are looked at
again 60 ms after a window comes, goes, is minimized, maximized or moved, the workspace or the work area changes. It is the Windows menu of the
panel ("Tiling"). The GNOME shortcuts `Super+Alt+Left/Right` are workspace switches, so the master size is on `Super+Alt+=` and `-`.
Drag and drop with a preview: carrying a tiled window by its title (`grab-op-begin` with `MOVING`) pauses the tiling and draws the layout it would make (`_updateGhost`: one outlined `.tile-ghost` cell for each tile, the carried window included, the cell under the pointer lit; `stylesheet.css`), on whichever monitor the pointer is on; on `grab-op-end` the window takes that cell and the others move over (`_insertAt`). Resizing a tile by its border (`grab-op-begin` with a `RESIZING_*` op) pauses the tiling too; at `grab-op-end` `_resized` reads the new size and keeps what it says: the master size of the Master layouts (`master-factor`), the column width of Scrolling (`column-width`), Dwindle's split shares and the weights of Horizontal and Vertical (kept in memory per monitor for that layout and count of windows: another, and they start over). Grid, Three columns and Monocle have no sizes to set, so the window goes back. A window going to its tile glides there (`_glide`: its actor is moved back by the distance and eased to 0; `animate`, and the system's animations switch). Snapping to a screen edge with a preview is GNOME's own (`edge-tiling`) and is not repeated here. Tested in a headless shell with three windows through every layout (`/tmp`-style script: enable the extension, set `enabled`, read the frame rects).

### Tile as a layout manager (GNOME): the pieces

The brief for a "window tiling layout manager" (ten layouts, panel with Overview / Layouts / Workspaces / Rules / Appearance / Shortcuts /
Monitors / Profiles / Advanced, quick switcher, CLI, profiles, rollback) is built for GNOME on Tile, not on Hyprland: it moves the
real windows of this session. Layers: `shell/tile/config.js` (pure data: `layout-map`, `window-rules`, direction maths, tested in
`tests/island/tileConfig.test.js`); `extension.js` (the engine, and `org.niro.Tile` on the session bus: `GetState`, `ListLayouts`,
`ApplyLayout(layout, workspace, monitor)` with 0/-1 for "not given", `ClearLayout`, `SetEnabled`, `Retile`, signal `StateChanged`);
the command line and the panel talk to that and to the settings. Per-workspace and per-monitor layouts: `layout-map`
(`{"workspaces": {"2": "grid"}, "monitors": {"1": "monocle"}}`, a workspace's wins over its monitor's, which wins over `layout`).
Rules: `window-rules` (`float`, `tile`, or `workspace` to send an app's windows there). Directional focus and swap: `Super+Ctrl+arrows`,
with Shift to swap (`neighbor()` in config.js picks the window nearest that way).

### `niro-tile` (the command line) and the backend

`control/src/tileBackend.ts` is what both `niro-tile` (`control/src/tileCli.ts`, launcher `control/niro-tile`, installed to `/usr/bin`) and the panel's Tiling
pages use. It reads the settings and asks the extension over D-Bus (`org.niro.Tile`) for the live state; with no extension running, `apply`
writes the settings and the extension reads them when it starts. `change()` is the only way several settings are written: checked
(`validate`), the old values saved as a backup (`~/.local/state/niro/tile-backups`, newest 20), written, read back, and put back if
anything differs or throws. `niro-tile undo` restores the newest backup. Profiles are JSON files (`version` 1) in
`~/.config/niro/tile-profiles`; a file with another version or bad values is refused with a sentence, never half-applied. `layouts.js` and
`config.js` are copied into `control/build/tile/` by `npm run build` so the panel and the command line use the same pure code.
Commands: `state`, `layouts`, `apply <layout> [--workspace N] [--monitor N]`, `clear`, `on|off|toggle`, `profile list|save|load|delete|export|import`,
`validate [file]`, `reset [--yes]`, `undo`, `doctor` (`--json` for the ones that print data). Tested by `tests/gjs/tileBackend.test.js`.

### The panel's Tiling module

`control/src/tilingPage.ts`, in the sidebar as "Tiling": Overview (switch, layout, workspace, monitors, windows, session; a banner when the session is not GNOME),
Layouts (ten cards, each with a diagram drawn from `arrange()`, and "Apply to": all workspaces, the active one, or a monitor), Workspaces and Monitors
(a layout for each, "Default" clears it; both follow the shell every 1.5 s while shown, so a hotplug shows), Window Rules (list, add form with a picker of the open windows'
classes), Appearance (gaps, animation, corner radius, opacity, shadow; there is no border setting because GNOME draws none and the tiling adds none), Shortcuts (the
recorder with clash detection), Profiles (save, load, export, import, delete, undo, reset) and Advanced (checks, the two JSON documents with check-then-save, the log, the live
state). A failure is a toast with the reason. Tested with a display by `tests/gjs/tilingPage.test.js`; without the extension running every page says so.

### The quick layout switcher and the real-window test

`shell/tile/switcher.js`: `Super+Alt+Space` (`shortcut-switcher`; plain `Super+Space` is Niro Search's) opens a compact overlay over the monitor with the focused
window: the ten layouts as cards with a diagram each, a search box (`searchLayouts()` in layouts.js: every word must be in the id, name or description), a larger preview
of the one chosen, arrows/Tab to move, Enter or a click to apply it to the active workspace, Escape or a click outside to leave. Keys are taken on their way down
(`captured-event` on the backdrop) because the text field would otherwise keep arrows, Enter and Escape for itself. `tests/shell/tile.sh` (part of `run-staged.sh`) opens 1, 2, 3, 4, 6 and 10 real
windows in a headless shell, applies each of the ten layouts, and compares every window's frame with `arrange()` (`tileExpect.mjs`); a window that cannot be as small as
its tile keeps its own minimum size at the tile's corner (`_holdMinimum`), which the check accepts. It then closes a window and checks the nine left are laid out again.
It runs with its own settings file (keyfile backend) so `gsettings` and the extension see the same values.

## Emoji picker: kaomoji, text symbols, the shortcut

`Super+.` and `Super+;` open it (`emoji-keybind`, two defaults, as on Windows); `Super+.` was already the old default, and the settings (shortcut, where it opens, size,
columns, paste, keep open…) are now in the panel's Search page ("Emoji Picker", the `emoji` source of the catalog). The database `shell/emoji/data/emojis.db` has two more groups than
the Unicode emoji (which are untouched): "Kaomoji" (text faces) and "Text Symbols". They are made by `scripts/build-emoji-extras.py` (edit the lists in it and run it again: the two groups
are replaced); a symbol's search words are its Unicode name plus English and Indonesian words for its set. In the picker they are categories 9 and 10 (`emojiCategory.js`):
Kaomoji are laid out two to a row, in a text font, in wide buttons. `tests/island/emojiExtras.test.js` reads the database with `node:sqlite`. The extension's code
(categories, buttons) is loaded once per shell: a new version shows after the next login; a new database is read each time the extension is enabled.

## AI usage: Claude, ChatGPT Plus/Pro, Grok, opencode Go, DeepSeek

The Usage page (`shell/island/src/pages/usage.ts`, 226 px tall, shortcut Super+Alt+U) shows every provider at once, a column each in the order Claude, DeepSeek, ChatGPT, opencode, Grok (equal columns, up to five), with nothing to scroll or page through: the name and plan, up to three limits (name and share, a bar, when it starts over) and at the foot when it was read or what is wrong. DeepSeek's column says the balance in words.

`crates/island-daemon/src/usage.rs` reads each provider where its own tool does: Claude with Claude Code's sign-in, ChatGPT (Plus or Pro; the 5-hour and weekly limits) with
Codex's sign-in (`codex login`, "Sign in with ChatGPT"; the plan name comes from the answer, so Plus shows as Plus), Grok with its CLI's. **DeepSeek** has no sign-in: its
card shows the balance left on an API account (`GET https://api.deepseek.com/user/balance`, `Authorization: Bearer <key>`; a balance in each currency, topped up and
granted, "too low to call the API" when `is_available` is false), no bars, as there are no limits. The key is in `~/.config/niro/deepseek-api-key` (mode 600, one line, written by the
panel's Island > AI Usage > Connections) or in `DEEPSEEK_API_KEY`; it is never in dconf, never logged and never sent to the page. `usage-deepseek` is off by default (it would be a card
nobody asked for); saving a key turns it and `usage-enabled` on. With the switch on and no key, the card says where to put it. The balance is asked every ten minutes and when the page opens
(at most every two). **opencode** (the Go plan) is read with the plan's API key, the `opencode-go` entry of opencode's own `auth.json` (`opencode auth login`; `assistant::opencode_go_key`): `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>` answers `{usage: {rolling, weekly, monthly: {status, percent, resetsAt}}}`, shown as "5 hours", "Week" and "Month". opencode documents no usage service (its console shows the limits): this is the request other tools make, taken from their documentation, never tried here against a real Go plan (this computer has none), so a different answer is shown as "could not read opencode's limits" and the last numbers stay. `usage-opencode` is on by default and the card shows only with that key. The key is never logged or sent to the page. Backs off as Claude's reads do.
The panel's "Connections" group (`control/src/aiConnections.ts`) says, for each AI, whether its sign-in is found and how to make one. Tested by Rust tests (the
parsing, and the HTTP request against a local server, including 401, 500, a non-JSON answer and no network) and by `tests/gjs/aiConnections.test.js`.

## Agent alerts: Claude Code, Codex, opencode

`crates/island-daemon/src/agents/`: each AI runs `island-daemon --agent-hook <ai>` when it needs the user or finishes, and the island alerts (Claude Code and Codex can also be answered from the island). The hooks live in each AI's own config (`claude.rs`, `codex.rs`). **opencode** (`opencode.rs`) has no hook config: Island writes one marked plugin file, `~/.config/opencode/plugins/niro-island.js` (opencode loads every file of that folder), when `agent-alerts-opencode` is turned on, and removes it when it is turned off or Island is uninstalled (`--unhook-all`). A file of that name that is not Island's (no marker line) is never overwritten or removed. The plugin's `event` handler turns opencode's `permission.asked` (also `permission.updated` and `permission.v2.asked`), `question.asked` (and `.v2`) and `session.idle` (or a `session.status` that went idle) into the Claude Code words `hook_event_name: "Notification"` (`permission_prompt`, `elicitation_dialog`) and `"Stop"`, so `hook.rs` needs nothing new but the name. It only tells: opencode's permissions are answered in opencode, because the call that answers them from a plugin differs between its versions. Off by default, since it writes into another program's folder. Not run against a real opencode here (it is not installed on this computer): the plugin's event names come from another working plugin for the same opencode and from its documentation; the plugin file, the hook and the island's alert were each tested (Rust tests; a headless shell fed the same payloads the plugin sends).

## Releasing and the update check

The island's "a newer version is out" (`crates/island-daemon/src/updates.rs`, Settings → About) asks `https://api.github.com/repos/nerufuyo/niro-control/releases/latest` at most once a day (`check-updates`, on by default; only the request is sent) and compares the release's tag, without the `v`, with its own version number by number. Nothing is downloaded or run by Island: Settings offers the release page and, on Fedora, the command `sudo dnf upgrade niro-control`. (Earlier it could run an installer script from the original project; that is gone, and `tests/island/version.test.js` keeps any such pipe and any other project's address out.)

One version is kept in three places, which `tests/island/version.test.js` keeps equal: `VERSION` (the package's), the Rust workspace and the extension's `metadata.json`. Raise it with `scripts/set-version.sh X.Y.Z`, merge, then, from an up-to-date `main`, `NOTES="what changed" scripts/release.sh`: it builds the RPM, makes the GitHub release `vX.Y.Z` with it attached (without a release, nobody is told anything) and runs `scripts/publish-rpm-repo.sh`, which puts the RPM in a dnf repository on GitHub Pages (the `gh-pages` branch, `rpm/`, the three newest packages; the repo file is `niro-control.repo`). The repository is unsigned; a signed one (a Copr project, or a GPG key kept by the maintainer) is the next step if the project grows. The RPM's own release number is the commit count, so a build between two releases is not an update: only a higher VERSION is. No GitHub Actions: the token used here lacks the `workflow` scope, so releases are made by hand with these scripts.
