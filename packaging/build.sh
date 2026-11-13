#!/bin/bash
# Builds the one package, out/niro-control_<VERSION>+git<commits>_amd64.deb, from every part of the repo.
# Run it through `make deb`. Parts: shell/{island,dock,search} (TypeScript extensions), crates/ (Rust programs behind
# the island), control/ (the control panel), data/ (units, D-Bus services, fonts, defaults), packaging/debian/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
OUT="$ROOT/out"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
VER="$(cat VERSION)+git$(git rev-list --count HEAD 2>/dev/null || echo 0)"; P="$W/niro-control"
EXTDIR="$P/usr/share/gnome-shell/extensions"
mkdir -p "$OUT" "$P/DEBIAN"

# --- TypeScript: the extensions and the control panel
[ -d node_modules ] || npm ci >/dev/null
npm run --silent build

# --- Island (extension: sources' assets + compiled code)
EXT="$EXTDIR/island@niro.local"; mkdir -p "$EXT"
(cd shell/island && find . -type f ! -name '*.ts' ! -name tsconfig.json ! -name gschemas.compiled ! -path './build/*' -print0 | cpio -0pdm "$EXT" 2>/dev/null)
cp -r shell/island/build/. "$EXT"/; glib-compile-schemas "$EXT/schemas"

# --- Dock
EXT="$EXTDIR/dock@niro.local"; mkdir -p "$EXT"
cp -r shell/dock/dist/. "$EXT"/; cp shell/dock/metadata.json shell/dock/stylesheet.css "$EXT"/
cp -r shell/dock/schemas "$EXT"/; rm -f "$EXT"/schemas/gschemas.compiled; glib-compile-schemas "$EXT/schemas"

# --- Search
EXT="$EXTDIR/search@niro.local"
install -D -m 644 shell/search/build/extension.js "$EXT/extension.js"
install -D -m 644 shell/search/metadata.json "$EXT/metadata.json"
install -D -m 644 shell/search/stylesheet.css "$EXT/stylesheet.css"

# --- Blur, Corners, Emoji (kept as they were, renamed) and Emulator (TypeScript)
for pair in blur:blur corners:corners emoji:emoji; do
  src="${pair%%:*}"; EXT="$EXTDIR/${pair##*:}@niro.local"; mkdir -p "$EXT"
  cp -r "shell/$src"/. "$EXT"/; rm -f "$EXT"/schemas/gschemas.compiled; glib-compile-schemas "$EXT/schemas"
done
EXT="$EXTDIR/emulator@niro.local"
install -D -m 644 shell/emulator/build/extension.js "$EXT/extension.js"
install -D -m 644 shell/emulator/metadata.json "$EXT/metadata.json"

# --- The island's programs (Rust): daemon, shelf window, speech recognition
FEATURES=(); { command -v glslc >/dev/null && pkg-config --exists vulkan; } || FEATURES=(--no-default-features)
cargo build --release -p island-daemon -p island-shelf >&2
cargo build --release -p island-whisper "${FEATURES[@]}" >&2
for b in island-daemon island-shelf island-whisper; do install -D -m 755 "target/release/$b" "$P/usr/bin/$b"; done
install -D -m 755 scripts/island-charge-limit "$P/usr/bin/island-charge-limit"
install -D -m 755 scripts/island-setup-voice.sh "$P/usr/bin/island-setup-voice"
for u in org.niro.island.Daemon.service org.niro.island.ShelfWindow.service; do
  sed 's|@BINDIR@|/usr/bin|' "data/$u" | install -D -m 644 /dev/stdin "$P/usr/share/dbus-1/services/$u"
done
sed -e 's|@BINDIR@|/usr/bin|' -e 's|file://%h/.local/share/doc/island|file:///usr/share/doc/niro-control|' data/island-daemon.service \
  | install -D -m 644 /dev/stdin "$P/usr/lib/systemd/user/island-daemon.service"
install -D -m 644 data/fonts/InterVariable.ttf "$P/usr/share/fonts/truetype/island/InterVariable.ttf"
install -D -m 644 data/fonts/Inter-LICENSE.txt "$P/usr/share/fonts/truetype/island/Inter-LICENSE.txt"
install -D -m 644 README.md "$P/usr/share/doc/niro-control/README.md"

# --- The control panel, the shared schema, the defaults
for f in control/build/*.js; do install -D -m 644 "$f" "$P/usr/share/niro-control/$(basename "$f")"; done
echo "$VER" | install -D -m 644 /dev/stdin "$P/usr/share/niro-control/VERSION"
install -D -m 755 control/niro-control "$P/usr/bin/niro-control"
install -D -m 644 control/org.niro.Control.desktop "$P/usr/share/applications/org.niro.Control.desktop"
install -D -m 644 control/org.niro.control.gschema.xml "$P/usr/share/glib-2.0/schemas/org.niro.control.gschema.xml"
install -D -m 644 data/dconf/00-niro "$P/etc/dconf/db/local.d/00-niro"
install -D -m 644 data/dconf/profile-user "$P/etc/dconf/profile/user"

# --- Package
chmod -R u=rwX,go=rX "$P/usr" "$P/etc" # copied files keep their source's modes: make them readable
find "$P/usr/bin" -type f -exec chmod 755 {} +
sed "s/@VERSION@/$VER/" packaging/debian/control.in > "$P/DEBIAN/control"
for s in preinst prerm postrm postinst; do install -m 755 "packaging/debian/$s" "$P/DEBIAN/$s"; done
dpkg-deb --root-owner-group -Zxz -b "$P" "$OUT/niro-control_${VER}_amd64.deb" >/dev/null
echo "built $OUT/niro-control_${VER}_amd64.deb"
