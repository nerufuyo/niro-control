# Niro Control

The look of the desktop in one place: the island on the top bar, the dock, an application search, and one control
panel that sets them all. One repo, one package (`niro-control`).

```
shell/island/   the island: GNOME Shell extension (TypeScript)         island@niro.local
shell/dock/     the dock: GNOME Shell extension (TypeScript)           dock@niro.local
shell/search/   application search, Super+Space (TypeScript)           search@niro.local
shell/emulator/ keeps the Android Emulator window on top (TypeScript)  emulator@niro.local
shell/blur/     window blur (Blur my Shell, GPL, kept as it was)       blur@niro.local
shell/corners/  rounded window corners (Reborn, GPL, patched)          corners@niro.local
shell/emoji/    emoji picker (Emoji Copy, GPL, kept as it was)         emoji@niro.local
crates/         Rust programs behind the island: island-daemon, island-shelf, island-whisper, island-core
control/        the control panel (TypeScript on GJS) and the shared schema org.niro.control
data/           systemd unit, D-Bus services, fonts, dconf defaults
scripts/        helper scripts shipped in the package
packaging/      the Debian package: build.sh and the maintainer scripts
tests/          tests for the island's logic (node --test)
docs/           how it fits together, how to maintain it, the island's D-Bus API
```

## Everyday commands

| | |
|---|---|
| `make` / `make test` | build the TypeScript, run the island's tests and the Rust tests |
| `make deb` | build `out/niro-control_<version>+git<commits>_amd64.deb` |
| `make install` | build the package and install it (log out and in to load the extensions) |
| `make lint` | check the dock's code with Biome |

`gsettings set org.niro.control opacity 70` does what the panel's slider does.

See `docs/MAINTAINING.md` for how the parts talk to each other and where to change things.

## Credits and licence

GPL-3.0-or-later (`LICENSE`). The island and the dock started as forks of zickrian/isle (GPL-3.0) and
vinnytherobot/MacOSDock (MIT, `shell/dock/LICENSE`); their copyright notices are kept in the files. `shell/blur`,
`shell/corners` and `shell/emoji` are copies of Blur my Shell (aunetx), Rounded Window Corners Reborn (flexagoon) and
Emoji Copy (felipeftn), all GPL-3.0, with their licences. The application search and the control panel are new. The Inter font is under the SIL OFL (`data/fonts/Inter-LICENSE.txt`).
