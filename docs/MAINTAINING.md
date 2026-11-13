# Maintaining Niro Control

## How the parts fit

- **`org.niro.control`** (`control/org.niro.control.gschema.xml`) is the one shared setting: tone (`accent`, `tint`),
  `opacity`, `blur`, `blur-strength`, and the search shortcut. The control panel writes it.
- **The island** (`shell/island/src/niroSync.ts`) listens to it and copies it to the other parts' own settings: its glass,
  the dock (`dock-opacity`, `dock-blur-enabled`, `dock-background-color`, indicator colours) and Blur my Shell. It also
  loads a small stylesheet in the accent colour.
- **The search** (`shell/search`) reads `org.niro.control` directly each time it opens.
- **The control panel** (`control/`) builds itself from `control/src/catalog.ts`, which `scripts/control-panel-items.py`
  writes from the schemas (`make catalog`; 132 settings). See "The control panel" below.
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
