# Niro Control

The look of the desktop in one place: Isle (the island on the top bar), the macOS-style dock, DigUp's search panel with
the Isle look, and one control panel that sets them all.

- `isle/`: the GNOME Shell extension (fork of zickrian/isle)
- `dock/`: the dock extension (fork of vinnytherobot/MacOSDock)
- `digup/`: DigUp's panel (fork of ARahim3/DigUp; `shell/` is the Tauri app)
- `control/`: the control panel (`niro-control`), the shared schema `org.niro.control` and the desktop defaults
- `packaging/build.sh`: builds the single package `out/niro-control_<ver>_amd64.deb`

`./packaging/build.sh`, then `sudo dpkg -i out/niro-control_*.deb`. Log out and in to load changes.
`gsettings set org.niro.control opacity 70` does what the panel's slider does.
