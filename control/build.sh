#!/bin/bash
# Builds the four local packages into ./out: neru-isle, neru-macos-dock, neru-digup-shell, neru-desktop-defaults.
# Sources: ~/projects/isle (gnome-extension/), ~/projects/macos-dock-upstream (make build), ~/projects/digup-upstream
# (build-install-linux.sh builds the binary). Version: 1.0.0~neru<N> (N: NERU_REV, default 1).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$HERE/out"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
REV="${NERU_REV:-1}"; VER="1.0.0~neru$REV"
ISLE=~/projects/isle/gnome-extension; DOCK=~/projects/macos-dock-upstream
DIGUP=~/projects/digup-upstream/shell/src-tauri/target/release/digup-shell
mkdir -p "$OUT"

control() { # name depends description
  mkdir -p "$W/$1/DEBIAN"
  printf 'Package: %s\nVersion: %s\nSection: gnome\nPriority: optional\nArchitecture: %s\nMaintainer: nerufuyo <local@localhost>\nDepends: %s\nDescription: %s\n' \
    "$1" "$VER" "${ARCH:-all}" "$2" "$3" > "$W/$1/DEBIAN/control"
}
pack() { dpkg-deb --root-owner-group -Zxz -b "$W/$1" "$OUT/$1_${VER}_${ARCH:-all}.deb" >/dev/null; echo "built $1"; }

# --- Isle
EXT=$W/neru-isle/usr/share/gnome-shell/extensions/isle@zickrian.github.io
control neru-isle "gnome-shell (>= 46)" "Isle: the notch-style island for the GNOME top bar (local build)"
mkdir -p "$EXT"; cp -r "$ISLE"/. "$EXT"/; glib-compile-schemas "$EXT/schemas"
cat > "$W/neru-isle/DEBIAN/postinst" <<'P'
#!/bin/sh
# The manual copy of the extension is given up: this package owns it now.
rm -rf /usr/local/share/gnome-shell/extensions/isle@zickrian.github.io
exit 0
P
chmod 755 "$W/neru-isle/DEBIAN/postinst"; pack neru-isle

# --- Dock
EXT=$W/neru-macos-dock/usr/share/gnome-shell/extensions/macos-dock@vinnytherobot.github.io
control neru-macos-dock "gnome-shell (>= 46)" "macOS-style dock for GNOME Shell (local build)"
(cd "$DOCK" && make build >/dev/null)
mkdir -p "$EXT"; cp -r "$DOCK"/dist/. "$EXT"/; cp "$DOCK"/metadata.json "$DOCK"/stylesheet.css "$EXT"/
cp -r "$DOCK"/schemas "$EXT"/; rm -f "$EXT"/schemas/gschemas.compiled; glib-compile-schemas "$EXT/schemas"
pack neru-macos-dock

# --- DigUp's shell, in place of the one in dig-up (a diversion: dig-up's updates leave ours alone)
ARCH=amd64 control neru-digup-shell "dig-up, util-linux" "DigUp panel with the Isle look, over the dig-up package (local build)"
mkdir -p "$W/neru-digup-shell/usr/bin" "$W/neru-digup-shell/etc/sysctl.d"
install -m 755 "$DIGUP" "$W/neru-digup-shell/usr/bin/digup-shell"
echo "fs.inotify.max_user_watches=1048576" > "$W/neru-digup-shell/etc/sysctl.d/60-digup-inotify.conf"
cat > "$W/neru-digup-shell/DEBIAN/preinst" <<'P'
#!/bin/sh
set -e
if [ "$1" = install ] || [ "$1" = upgrade ]; then
  dpkg-divert --package neru-digup-shell --add --rename --divert /usr/bin/digup-shell.distrib /usr/bin/digup-shell
fi
exit 0
P
cat > "$W/neru-digup-shell/DEBIAN/postrm" <<'P'
#!/bin/sh
set -e
if [ "$1" = remove ]; then
  dpkg-divert --package neru-digup-shell --remove --rename /usr/bin/digup-shell
fi
exit 0
P
cat > "$W/neru-digup-shell/DEBIAN/postinst" <<'P'
#!/bin/sh
sysctl -q --system >/dev/null 2>&1 || true
exit 0
P
chmod 755 "$W"/neru-digup-shell/DEBIAN/{preinst,postrm,postinst}
ARCH=amd64 pack neru-digup-shell

# --- Defaults for every account: the extensions on, the dock's favourites
control neru-desktop-defaults "neru-isle, neru-macos-dock, dconf-cli, python3-gi, gir1.2-gtk-4.0, gir1.2-adw-1" "System defaults for the neru desktop: extensions on, dock favourites"
mkdir -p "$W/neru-desktop-defaults/etc/dconf/db/local.d" "$W/neru-desktop-defaults/etc/dconf/profile"
cat > "$W/neru-desktop-defaults/etc/dconf/db/local.d/00-neru" <<'P'
[org/gnome/shell]
enabled-extensions=['isle@zickrian.github.io', 'macos-dock@vinnytherobot.github.io', 'blur-my-shell@aunetx', 'rounded-window-corners@fxgn', 'user-theme@gnome-shell-extensions.gcampax.github.com', 'tiling-assistant@ubuntu.com']
favorite-apps=['org.gnome.Nautilus.desktop', 'google-chrome.desktop', 'yelp.desktop', 'orca.desktop', 'android-emulator.desktop', 'bytedance-lark.desktop', 'steam.desktop']
P
mkdir -p "$W/neru-desktop-defaults/usr/share/glib-2.0/schemas"
cp "$HERE"/schemas/org.neru.desktop.gschema.xml "$W/neru-desktop-defaults/usr/share/glib-2.0/schemas/"
mkdir -p "$W/neru-desktop-defaults/usr/bin" "$W/neru-desktop-defaults/usr/share/applications"
install -m 755 "$HERE/files/neru-settings" "$W/neru-desktop-defaults/usr/bin/neru-settings"
install -m 644 "$HERE/files/org.neru.Settings.desktop" "$W/neru-desktop-defaults/usr/share/applications/org.neru.Settings.desktop"
printf 'user-db:user\nsystem-db:local\n' > "$W/neru-desktop-defaults/etc/dconf/profile/user"
printf '#!/bin/sh\nglib-compile-schemas /usr/share/glib-2.0/schemas\ndconf update\nexit 0\n' > "$W/neru-desktop-defaults/DEBIAN/postinst"; chmod 755 "$W/neru-desktop-defaults/DEBIAN/postinst"
pack neru-desktop-defaults
ls -la "$OUT"
