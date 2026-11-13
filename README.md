# Niro Control

The look of the desktop in one place: Isle (the island on the top bar), the macOS-style dock, an application search, and
one control panel that sets them all.

- `isle/`: the GNOME Shell extension (fork of zickrian/isle)
- `dock/`: the dock extension (fork of vinnytherobot/MacOSDock)
- `search/`: Niro Search, the application search (a GNOME Shell extension, Super+Space)
- `control/`: the control panel (TypeScript on GJS, `niro-control`), the shared schema `org.niro.control` and the desktop defaults
- `packaging/build.sh`: builds the single package `out/niro-control_<ver>_amd64.deb`

`./packaging/build.sh`, then `sudo dpkg -i out/niro-control_*.deb`. Log out and in to load changes.
`gsettings set org.niro.control opacity 70` does what the panel's slider does.

## Languages

TypeScript for what we write: Isle's extension (`isle/gnome-extension`, files carry `// @ts-nocheck` until typed one by
one; the build output is token-identical to the old JavaScript), the dock, the control panel, and and the application search. Left as
upstream has it: Isle's Rust daemon (`isle/crates`).

`npm install`, `npm test` (builds Isle, runs its 70 tests).
