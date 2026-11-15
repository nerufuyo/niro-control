# Niro Control

<p align="center"><img src="data/icons/hicolor/scalable/apps/org.niro.Control.svg" width="96" alt="Niro Control icon"></p>

**One look for the whole GNOME desktop.** A top-bar island, a macOS-style dock, an application search, window blur and
rounded corners, and a control panel that sets them all from one place. One repository, one `.deb`.

Runs on **Fedora 45 (GNOME Shell 51)** and **Ubuntu 24.04 (GNOME Shell 46)**, on Wayland. The extensions declare GNOME Shell 46 to 51.
Packages: `.rpm` for Fedora, `.deb` for Ubuntu and Debian. Both are built by `make install` from the same tree.

## What you get

| Part | What it does |
|---|---|
| **Island** | A notch on the top bar that opens into music with synced lyrics, calls, a focus timer, reminders, a clipboard and file shelf, calendar, notifications, system stats, power controls, AI plan usage, and a voice assistant. Alerts for volume, battery, Bluetooth, meetings and more. |
| **Dock** | A dock with icon magnification, window previews, genie minimise (a pinned app's window becomes a thumbnail at the dock's end as on macOS, an unpinned app's icon becomes its overview), running indicators, auto-hide (also over full-screen apps, brought back by the screen edge) four positions, and its size and icons your own: icon size, spacing and padding, any installed icon theme, tiles (rounded, circle, glass), muted or grey icons. |
| **Search** | `Super+Space`: a command palette for applications, a calculator, unit conversion, open windows, every Niro setting, profiles, system actions (lock, Do Not Disturb, suspend, log out…) and the island's clipboard history. One typed action registry, also on D-Bus. |
| **Window blur** | Frosted glass behind application windows, with one strength and opacity for everything. |
| **Rounded corners** | Round corners and shadows for every window, including Chrome and Electron apps. |
| **Emoji, Emulator** | An emoji picker; keeps the Android Emulator window on top. |
| **Profiles** | Save the whole desktop as a profile and switch with one action: four built-ins (Everyday, Deep Work, Creative, Gaming), preview before applying, backups, rollback, import and export. |
| **Niro Control** | The control panel: a Home dashboard, Simple and Advanced modes, a sidebar with search over all 156 settings, live previews of the look, dock and windows, a shortcut recorder that refuses clashes, and per-setting reset. |

Opacity, blur, blur strength, accent and tint are set once, in **Look**, and the island, dock, search and windows follow.
Light and dark appearance both work, and the panel adapts to narrow windows.

## Screenshots

Taken from a headless GNOME Shell with the installed package (`scripts/screenshots.sh` regenerates them).

| Home and Settings Health | Profiles |
|---|---|
| ![Home](docs/images/panel-home.png) | ![Profiles](docs/images/panel-profiles.png) |
| **Look** | **Search: settings** |
| ![Look](docs/images/panel-look.png) | ![Search for a setting](docs/images/search-settings.png) |
| **Search: calculator** | **Search: profiles** |
| ![Calculator](docs/images/search-calculator.png) | ![Profiles in Search](docs/images/search-profiles.png) |

## Universal Appearance

One shared look with glass for backgrounds and solid text: presets, safe mode, a global switch, per-application rules and an opt-in GTK theme integration (never installed without your consent, always restorable). See [docs/APPEARANCE.md](docs/APPEARANCE.md) for what reaches which application, and what is only documented, not tested.

| Compatibility | GTK apps with the integration (Files, Settings) |
|---|---|
| ![Compatibility](reports/ui/compatibility.png) | ![Settings](reports/ui/gtk/settings-dark-on.png) |

## Install

```sh
git clone https://github.com/nerufuyo/niro-control.git
cd niro-control
make deps           # build tools and libraries from your distribution (asks for sudo)
make install        # builds the package for this system (.rpm on Fedora, .deb on Ubuntu/Debian) and installs it
```

Log out and in to load the extensions, then open **Niro Control** from the applications menu (or run `niro-control`).
`make rpm` or `make deb` only builds the package, into `out/`.

What `make deps` installs, if you prefer to do it by hand:

| | Fedora | Ubuntu / Debian |
|---|---|---|
| Rust 1.88+, C/C++ compiler | `rust cargo gcc gcc-c++` | `build-essential`, Rust from [rustup](https://rustup.rs) |
| Speech recognition (island-whisper) | `cmake clang-devel vulkan-loader-devel glslc` | `cmake libclang-dev libvulkan-dev glslc` |
| Island shelf window | `gtk4-devel libadwaita-devel glib2-devel` | `libgtk-4-dev` |
| Control panel and extensions | `nodejs npm gjs dconf` | `nodejs npm gjs dconf-cli` |
| Packaging | `rpm-build cpio` | `dpkg-dev cpio` |
| System tray icons, user themes | `gnome-shell-extension-appindicator gnome-shell-extension-user-theme` | `gnome-shell-extensions gnome-shell-extension-appindicator` |

Node 20+ is needed. The first build compiles whisper.cpp and takes a few minutes. Without `glslc` the speech recognition is
built for the CPU only.

On Fedora, if the extensions do not show up after logging in, enable them once: `gnome-extensions enable dock@niro.local`
(and `island@`, `search@`, `blur@`, `corners@`, `emoji@`, `emulator@`). The package sets them on by default through dconf.

## Repository layout

```
shell/island/   the island: GNOME Shell extension (TypeScript)         island@niro.local
shell/dock/     the dock (TypeScript)                                  dock@niro.local
shell/search/   application search (TypeScript)                        search@niro.local
shell/emulator/ Android Emulator window helper (TypeScript)            emulator@niro.local
shell/blur/     window blur (from Blur my Shell, GPL)                  blur@niro.local
shell/corners/  rounded corners (from Rounded Window Corners, GPL)     corners@niro.local
shell/emoji/    emoji picker (from Emoji Copy, GPL)                    emoji@niro.local
crates/         Rust programs behind the island: daemon, shelf window, speech recognition
control/        the control panel (TypeScript on GJS) and the shared schema org.niro.control
data/           systemd unit, D-Bus services, fonts, dconf defaults
packaging/      the Debian package
tests/          node and GJS tests
docs/           maintenance notes, the island's guide and D-Bus API, the list of every panel setting
```

## Development

| | |
|---|---|
| `make test` | build the TypeScript; run the node tests, the GJS tests (every setting binds, writes and resets), and the Rust tests |
| `make test-shell` | a headless GNOME Shell against this checkout, no installed package needed: extensions load, search, appearance, blur rules |
| `make test-dbus` | every D-Bus call the island makes against the real `island-daemon` |
| `make deb` | build `out/niro-control_<version>+git<commits>_amd64.deb` |
| `make catalog` | regenerate the control panel's settings catalog from the schemas |
| `make lint` | check the dock's code with Biome |

`gsettings set org.niro.control opacity 70` does what the panel's slider does. See [`docs/MAINTAINING.md`](docs/MAINTAINING.md)
for how the parts talk to each other and where to change things.

## Status

A personal desktop project, shared as it is. Tested on Ubuntu 24.04 (GNOME 46, Wayland, NVIDIA) and Fedora 45 (GNOME 51, Wayland):
on Fedora, all seven extensions enable in a real headless GNOME Shell 51 and the 156 node and GJS tests pass.
The Fedora `.rpm` has not yet been installed and used in a full session; `docs/UAT.md` is the checklist for that.
The island's TypeScript still carries `// @ts-nocheck`: converted from JavaScript, to be typed file by file.

## Credits and licence

GPL-3.0-or-later ([`LICENSE`](LICENSE)). The island and the dock started as forks of
[zickrian/isle](https://github.com/zickrian/isle) (GPL-3.0) and
[vinnytherobot/MacOSDock](https://github.com/vinnytherobot/MacOSDock) (MIT, [`shell/dock/LICENSE`](shell/dock/LICENSE)).
`shell/blur`, `shell/corners` and `shell/emoji` are copies of [Blur my Shell](https://github.com/aunetx/blur-my-shell),
[Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners) and
[Emoji Copy](https://github.com/felipeftn/emoji-copy), all GPL-3.0, with their licences. The application search and the
control panel are new. The Inter font is under the SIL OFL ([`data/fonts/Inter-LICENSE.txt`](data/fonts/Inter-LICENSE.txt)).
Their copyright notices are kept in the files.
