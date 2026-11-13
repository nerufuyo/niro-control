# Niro Control

The look of the desktop in one place: Island (the island on the top bar), the macOS-style dock, an application search, and
one control panel that sets them all.

- `island/`: the island on the top bar (GNOME Shell extension and its background programs)
- `dock/`: the dock extension
- `search/`: Search, the application search (a GNOME Shell extension, Super+Space)
- `control/`: the control panel (TypeScript on GJS, `niro-control`), the shared schema `org.niro.control` and the desktop defaults
- `packaging/build.sh`: builds the single package `out/niro-control_<ver>_amd64.deb`

`./packaging/build.sh`, then `sudo dpkg -i out/niro-control_*.deb`. Log out and in to load changes.
`gsettings set org.niro.control opacity 70` does what the panel's slider does.

## Languages

TypeScript for what we write: Island's extension (`island/gnome-extension`, files carry `// @ts-nocheck` until typed one by
one; the build output is token-identical to the old JavaScript), the dock, the control panel, and the application search. Left as
upstream has it: Island's Rust daemon (`island/crates`).

`npm install`, `npm test` (builds Island, runs its 70 tests).

## Credits

The island and the dock started as forks of zickrian/isle and vinnytherobot/MacOSDock (both GPL); their licences and
copyright notices are kept in `island/` and `dock/`. The application search is new.
