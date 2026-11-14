# Maintaining Niro Control

## How the parts fit

- **`org.niro.control`** (`control/org.niro.control.gschema.xml`) is the one shared setting: tone (`accent`, `tint`),
  `opacity`, `blur`, `blur-strength`, and the search shortcut. The control panel writes it.
- **The island** (`shell/island/src/niroSync.ts`) listens to it and copies it to the other parts' own settings: its glass,
  the dock (`dock-opacity`, `dock-blur-enabled`, `dock-background-color`, indicator colours) and Blur my Shell. It also
  loads a small stylesheet in the accent colour.
- **The search** (`shell/search`) reads `org.niro.control` directly each time it opens.
- **The control panel** (`control/`) builds itself from `control/src/catalog.ts`, which `scripts/control-panel-items.py`
  writes from the schemas (`make catalog`; 143 settings). See "The control panel" below.
- **The island's programs** (`crates/`) are started by systemd (`island-daemon.service`) and D-Bus
  (`org.niro.island.Daemon`, `org.niro.island.ShelfWindow`); `docs/island-dbus-api.md` describes the API.

## Parts kept as they were

`shell/blur`, `shell/corners` and `shell/emoji` are copies of third-party GPL extensions (renamed `blur@`, `corners@`,
`emoji@niro.local`; their schemas keep the original ids so settings carry over). `shell/corners` has two small fixes
(a closing window no longer breaks its refresh). Ubuntu's own `user-theme`, `tiling-assistant` and `appindicator`
extensions are package dependencies, not copies. Vitals and system-monitor are gone: the island's System page shows
CPU, memory, temperature and network.

## Changing things

| To | Edit |
|---|---|
| add a shared look setting | `control/org.niro.control.gschema.xml`, then `niroSync.ts` (what copies it) |
| add an island or dock setting | its own schema (`shell/island/schemas`, `shell/dock/schemas`): the panel picks it up |
| change a shortcut default | the schema key's default (`search-shortcut`, `shortcut-*`) |
| change which extensions are on, the dock's favourites | `data/dconf/00-niro` |
| change what the package installs or runs | `packaging/build.sh`, `packaging/debian/*` |

## Types and tests

The island's files start with `// @ts-nocheck`: converted from JavaScript, the build output is token-identical to the
old JavaScript. Remove the comment from one file at a time and fix what the compiler says. The dock is strict already.
`tests/island` run against the compiled island (`shell/island/build`).

## Releasing

Bump `VERSION`, `make deb`, `make install`. The package version is `VERSION+git<commit count>`. Extensions and the
panel load after logging out and in. The island's update check against the original project is off by default.

## Rust notes

`island-whisper` needs cmake, a C++ compiler, libclang and, for the GPU, `libvulkan-dev` and `glslc`;
`island-shelf` needs `libgtk-4-dev`. The first build compiles whisper.cpp and takes several minutes.

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

`control/src/glass.ts` (pure, tested) defines the panel's look as three layers, and `window.ts` loads its `stylesheet()` at a priority above the user's own `~/.config/gtk-4.0/gtk.css` (that file can carry a whole-desktop GTK theme that would otherwise repaint the panel with opaque backgrounds and a fixed text colour):

1. glass: the window's own background. The only layer that follows Look > Opacity (and the Look tint in the dark scheme).
2. surfaces: sidebar, content, groups, raised things: fixed alphas, high enough to carry text over any wallpaper.
3. foreground: text and dividers: fixed colours. Nothing sets `opacity` on a container; libadwaita's dimming of secondary text (an `opacity`) is replaced by a colour, because opacity over glass dims the text with it.

The shell's blur extension used to fade whole windows by the Look opacity; the panel (`org.niro.Control`) is now exempt (it still gets the blur behind it) because it paints its own glass. That change is in `shell/blur/components/applications/index.js` and loads at the next login.

`scripts/glass-matrix.sh` takes screenshots over four wallpapers, several opacities and both schemes in a private headless shell (it loads the repository's blur extension, not the installed one). `tests/island/glass.test.js` checks that no token but the glass follows the opacity and that primary and secondary text reach WCAG AA over black, white and mid wallpapers at every opacity.
