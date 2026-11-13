#!/bin/bash
# Builds the one package, out/niro-control_<ver>_amd64.deb: Island, the dock, the application search, the control panel and the
# desktop defaults. NIRO_REV bumps the version (1.0.0~niro<N>).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/out"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
REV="${NIRO_REV:-1}"; VER="1.0.0~niro$REV"; P="$W/niro-control"
mkdir -p "$OUT" "$P/DEBIAN"

# --- Island
(cd "$ROOT" && { [ -d node_modules ] || npm ci >/dev/null; } && npx tsc -p island/gnome-extension && npx tsc -p control && npx tsc -p search)
EXT="$P/usr/share/gnome-shell/extensions/island@niro.local"
mkdir -p "$EXT"; (cd "$ROOT/island/gnome-extension" && find . -type f ! -name '*.ts' ! -name tsconfig.json ! -name gschemas.compiled -print0 | cpio -0pdm "$EXT" 2>/dev/null)
cp -r "$ROOT"/island/build/extension/. "$EXT"/; glib-compile-schemas "$EXT/schemas"

# --- The dock
(cd "$ROOT/dock" && { [ -d node_modules ] || npm ci >/dev/null; } && make build >/dev/null)
EXT="$P/usr/share/gnome-shell/extensions/dock@niro.local"
mkdir -p "$EXT"; cp -r "$ROOT"/dock/dist/. "$EXT"/; cp "$ROOT"/dock/metadata.json "$ROOT"/dock/stylesheet.css "$EXT"/
cp -r "$ROOT"/dock/schemas "$EXT"/; rm -f "$EXT"/schemas/gschemas.compiled; glib-compile-schemas "$EXT/schemas"

# --- Island's background programs: the daemon, the shelf window, speech recognition (built from island/crates)
FEATURES=(); { command -v glslc >/dev/null && pkg-config --exists vulkan; } || FEATURES=(--no-default-features)
(cd "$ROOT/island" && cargo build --release -p island-daemon -p island-shelf >&2 && cargo build --release -p island-whisper "${FEATURES[@]}" >&2)
for b in island-daemon island-shelf island-whisper; do install -D -m 755 "$ROOT/island/target/release/$b" "$P/usr/bin/$b"; done
install -D -m 755 "$ROOT/island/scripts/island-charge-limit" "$P/usr/bin/island-charge-limit"
install -D -m 755 "$ROOT/island/scripts/setup-voice.sh" "$P/usr/bin/island-setup-voice"
for u in org.niro.island.Daemon.service org.niro.island.ShelfWindow.service; do
  sed 's|@BINDIR@|/usr/bin|' "$ROOT/island/data/$u" | install -D -m 644 /dev/stdin "$P/usr/share/dbus-1/services/$u"
done
sed -e 's|@BINDIR@|/usr/bin|' -e 's|file://%h/.local/share/doc/island|file:///usr/share/doc/niro-control|' "$ROOT/island/data/island-daemon.service" \
  | install -D -m 644 /dev/stdin "$P/usr/lib/systemd/user/island-daemon.service"
install -D -m 644 "$ROOT/island/data/fonts/InterVariable.ttf" "$P/usr/share/fonts/truetype/island/InterVariable.ttf"
install -D -m 644 "$ROOT/island/data/fonts/Inter-LICENSE.txt" "$P/usr/share/fonts/truetype/island/Inter-LICENSE.txt"
install -D -m 644 "$ROOT/island/README.md" "$P/usr/share/doc/niro-control/README.md"

# --- Search: the application search (Super+Space)
EXT="$P/usr/share/gnome-shell/extensions/search@niro.local"
install -D -m 644 "$ROOT/search/build/extension.js" "$EXT/extension.js"
install -D -m 644 "$ROOT/search/metadata.json" "$EXT/metadata.json"
install -D -m 644 "$ROOT/search/stylesheet.css" "$EXT/stylesheet.css"

# --- The control panel, the shared schema, the defaults
install -D -m 644 "$ROOT/control/build/niro-control.js" "$P/usr/share/niro-control/niro-control.js"
install -D -m 755 /dev/stdin "$P/usr/bin/niro-control" <<'L'
#!/bin/sh
exec gjs -m /usr/share/niro-control/niro-control.js "$@"
L
install -D -m 644 "$ROOT/control/org.niro.Control.desktop" "$P/usr/share/applications/org.niro.Control.desktop"
install -D -m 644 "$ROOT/control/org.niro.control.gschema.xml" "$P/usr/share/glib-2.0/schemas/org.niro.control.gschema.xml"
install -D -m 644 /dev/stdin "$P/etc/dconf/db/local.d/00-niro" <<'D'
[org/gnome/shell]
enabled-extensions=['island@niro.local', 'dock@niro.local', 'search@niro.local', 'blur-my-shell@aunetx', 'rounded-window-corners@fxgn', 'user-theme@gnome-shell-extensions.gcampax.github.com', 'tiling-assistant@ubuntu.com']
favorite-apps=['org.gnome.Nautilus.desktop', 'google-chrome.desktop', 'yelp.desktop', 'orca.desktop', 'android-emulator.desktop', 'bytedance-lark.desktop', 'steam.desktop']
D
install -D -m 644 /dev/stdin "$P/etc/dconf/profile/user" <<< $'user-db:user\nsystem-db:local'

printf 'Package: niro-control\nVersion: %s\nSection: gnome\nPriority: optional\nArchitecture: amd64\nMaintainer: nerufuyo <local@localhost>\nDepends: gnome-shell (>= 46), dconf-cli, libgtk-4-1, libvulkan1, fontconfig, gjs, gir1.2-gtk-4.0, gir1.2-adw-1\nReplaces: neru-island, neru-dock, neru-digup-shell, neru-desktop-defaults\nConflicts: neru-island, neru-dock, neru-digup-shell, neru-desktop-defaults\nDescription: Niro Control: the look of the desktop in one place\n Island (the island on the top bar), the macOS-style dock, an application search, and one control panel\n (org.niro.control: tone, opacity, blur) that sets them all. Local build.\n' "$VER" > "$P/DEBIAN/control"
cat > "$P/DEBIAN/preinst" <<'S'
#!/bin/sh
set -e
# An earlier niro-control kept DigUp's shell in place of dig-up's: give that up.
if dpkg-divert --list niro-control | grep -q digup-shell; then
  dpkg-divert --package niro-control --remove --rename /usr/bin/digup-shell || true
fi
exit 0
S
cat > "$P/DEBIAN/prerm" <<'S'
#!/bin/sh
if [ "$1" = remove ]; then systemctl --global disable island-daemon.service >/dev/null 2>&1 || true; fi
exit 0
S
cat > "$P/DEBIAN/postrm" <<'S'
#!/bin/sh
exit 0
S
cat > "$P/DEBIAN/postinst" <<'S'
#!/bin/sh
rm -rf /usr/local/share/gnome-shell/extensions/island@niro.local
glib-compile-schemas /usr/share/glib-2.0/schemas
fc-cache /usr/share/fonts/truetype/island >/dev/null 2>&1 || true
rm -f /etc/systemd/user/graphical-session.target.wants/isled.service
systemctl --global enable island-daemon.service >/dev/null 2>&1 || true
dconf update
exit 0
S
chmod 755 "$P"/DEBIAN/{preinst,prerm,postrm,postinst}
dpkg-deb --root-owner-group -Zxz -b "$P" "$OUT/niro-control_${VER}_amd64.deb" >/dev/null
ls -la "$OUT"
