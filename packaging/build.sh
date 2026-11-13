#!/bin/bash
# Builds the one package, out/niro-control_<ver>_amd64.deb: Isle, the dock, DigUp's panel, the control panel and the
# desktop defaults. NIRO_REV bumps the version (1.0.0~niro<N>).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/out"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
REV="${NIRO_REV:-1}"; VER="1.0.0~niro$REV"; P="$W/niro-control"
mkdir -p "$OUT" "$P/DEBIAN"

# --- Isle
(cd "$ROOT" && { [ -d node_modules ] || npm ci >/dev/null; } && npx tsc -p isle/gnome-extension && npx tsc -p control && npx tsc -p digup/shell/ui-ts)
EXT="$P/usr/share/gnome-shell/extensions/isle@zickrian.github.io"
mkdir -p "$EXT"; (cd "$ROOT/isle/gnome-extension" && find . -type f ! -name '*.ts' ! -name tsconfig.json ! -name gschemas.compiled -print0 | cpio -0pdm "$EXT" 2>/dev/null)
cp -r "$ROOT"/isle/build/extension/. "$EXT"/; glib-compile-schemas "$EXT/schemas"

# --- The dock
(cd "$ROOT/dock" && { [ -d node_modules ] || npm ci >/dev/null; } && make build >/dev/null)
EXT="$P/usr/share/gnome-shell/extensions/macos-dock@vinnytherobot.github.io"
mkdir -p "$EXT"; cp -r "$ROOT"/dock/dist/. "$EXT"/; cp "$ROOT"/dock/metadata.json "$ROOT"/dock/stylesheet.css "$EXT"/
cp -r "$ROOT"/dock/schemas "$EXT"/; rm -f "$EXT"/schemas/gschemas.compiled; glib-compile-schemas "$EXT/schemas"

# --- DigUp's panel (built here: cargo build, not installed)
(cd "$ROOT/digup/shell/src-tauri" && cargo build --release --features tauri/custom-protocol >&2)
install -D -m 755 "$ROOT/digup/shell/src-tauri/target/release/digup-shell" "$P/usr/bin/digup-shell"
install -D -m 644 /dev/stdin "$P/etc/sysctl.d/60-digup-inotify.conf" <<< "fs.inotify.max_user_watches=1048576"

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
enabled-extensions=['isle@zickrian.github.io', 'macos-dock@vinnytherobot.github.io', 'blur-my-shell@aunetx', 'rounded-window-corners@fxgn', 'user-theme@gnome-shell-extensions.gcampax.github.com', 'tiling-assistant@ubuntu.com']
favorite-apps=['org.gnome.Nautilus.desktop', 'google-chrome.desktop', 'yelp.desktop', 'orca.desktop', 'android-emulator.desktop', 'bytedance-lark.desktop', 'steam.desktop']
D
install -D -m 644 /dev/stdin "$P/etc/dconf/profile/user" <<< $'user-db:user\nsystem-db:local'

printf 'Package: niro-control\nVersion: %s\nSection: gnome\nPriority: optional\nArchitecture: amd64\nMaintainer: nerufuyo <local@localhost>\nDepends: gnome-shell (>= 46), dig-up, util-linux, dconf-cli, gjs, gir1.2-gtk-4.0, gir1.2-adw-1\nReplaces: neru-isle, neru-macos-dock, neru-digup-shell, neru-desktop-defaults\nConflicts: neru-isle, neru-macos-dock, neru-digup-shell, neru-desktop-defaults\nDescription: Niro Control: the look of the desktop in one place\n Isle (the island on the top bar), the macOS-style dock, DigUp'"'"'s panel with the Isle look, and one control panel\n (org.niro.control: tone, opacity, blur) that sets them all. Local build.\n' "$VER" > "$P/DEBIAN/control"
cat > "$P/DEBIAN/preinst" <<'S'
#!/bin/sh
set -e
# DigUp's shell in place of the one in dig-up: dig-up's updates leave ours alone.
if [ "$1" = install ] || [ "$1" = upgrade ]; then
  dpkg-divert --list niro-control | grep -q digup-shell || dpkg-divert --package niro-control --add --rename --divert /usr/bin/digup-shell.distrib /usr/bin/digup-shell
fi
exit 0
S
cat > "$P/DEBIAN/postrm" <<'S'
#!/bin/sh
set -e
if [ "$1" = remove ]; then dpkg-divert --package niro-control --remove --rename /usr/bin/digup-shell; fi
exit 0
S
cat > "$P/DEBIAN/postinst" <<'S'
#!/bin/sh
rm -rf /usr/local/share/gnome-shell/extensions/isle@zickrian.github.io
glib-compile-schemas /usr/share/glib-2.0/schemas
dconf update
sysctl -q --system >/dev/null 2>&1 || true
exit 0
S
chmod 755 "$P"/DEBIAN/{preinst,postrm,postinst}
dpkg-deb --root-owner-group -Zxz -b "$P" "$OUT/niro-control_${VER}_amd64.deb" >/dev/null
ls -la "$OUT"
