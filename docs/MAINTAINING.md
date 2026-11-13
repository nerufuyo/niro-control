# Maintaining Niro Control

## How the parts fit

- **`org.niro.control`** (`control/org.niro.control.gschema.xml`) is the one shared setting: tone (`accent`, `tint`),
  `opacity`, `blur`, `blur-strength`, and the search shortcut. The control panel writes it.
- **The island** (`shell/island/src/niroSync.ts`) listens to it and copies it to the other parts' own settings: its glass,
  the dock (`dock-opacity`, `dock-blur-enabled`, `dock-background-color`, indicator colours) and Blur my Shell. It also
  loads a small stylesheet in the accent colour.
- **The search** (`shell/search`) reads `org.niro.control` directly each time it opens.
- **The control panel** (`control/src/niro-control.ts`) has a Look page of its own and builds the Island and Dock
  pages from those extensions' schemas: a new setting in a schema shows up without touching the panel (hide internal
  keys in `INTERNAL_KEYS`).
- **The island's programs** (`crates/`) are started by systemd (`island-daemon.service`) and D-Bus
  (`org.niro.island.Daemon`, `org.niro.island.ShelfWindow`); `docs/island-dbus-api.md` describes the API.

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
