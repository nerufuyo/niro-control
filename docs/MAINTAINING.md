# Maintaining Niro Control

## How the parts fit

- **`org.niro.control`** (`control/org.niro.control.gschema.xml`) is the one shared setting: tone (`accent`, `tint`),
  `opacity`, `blur`, `blur-strength`, and the search shortcut. The control panel writes it.
- **The island** (`shell/island/src/niroSync.ts`) listens to it and copies it to the other parts' own settings: its glass,
  the dock (`dock-opacity`, `dock-blur-enabled`, `dock-background-color`, indicator colours) and Blur my Shell. It also
  loads a small stylesheet in the accent colour.
- **The search** (`shell/search`) reads `org.niro.control` directly each time it opens.
- **The control panel** (`control/`) builds itself from `control/src/catalog.ts`, which `scripts/control-panel-items.py`
  writes from the schemas (`make catalog`; 158 settings). See "The control panel" below.
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
panel load after logging out and in. The island's update check against the original project is off by default.

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

The island's Controls page (`shell/island/src/pages/controls.ts`, shortcut Super+Alt+K) sets what one reaches for in GNOME's Quick Settings: volume and the microphone (sliders and mute), the screen's brightness, Bluetooth (power, and the paired devices to connect and disconnect), Wi-Fi (power, networks), the sound outputs and inputs, power mode, Do Not Disturb, Night Light, dark style and airplane mode. Four views under small tabs: Quick, Bluetooth, Wi-Fi, Sound. What the computer does not have (no backlight on a desktop, no Wi-Fi, no Bluetooth) is not shown. The services are in `systemControls.ts` and use what GNOME uses, so both always agree: the shell's mixer (`audio.ts`, now with the default input), `Main.brightnessManager` (GNOME 48+) or the settings daemon, GnomeBluetooth, nmcli for NetworkManager, power-profiles-daemon over D-Bus, rfkill. Secured Wi-Fi networks NetworkManager does not know yet open GNOME's own Wi-Fi settings for the password. Not run on real hardware here: brightness (the test computer is a desktop with no backlight) and Wi-Fi (none).
