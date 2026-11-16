#!/bin/bash
# Lays the repository out like the installed package under a throwaway prefix (no root, no Rust build besides the daemon):
# extensions, schemas, the daemon's D-Bus service. Prints the prefix. Used by run-staged.sh, so the shell tests run
# against this checkout instead of /usr.
set -euo pipefail
cd "$(dirname "$0")/../.."
P="${1:-$(mktemp -d)}"; X="$P/share/gnome-shell/extensions"
mkdir -p "$X" "$P/share/glib-2.0/schemas" "$P/share/dbus-1/services" "$P/share/niro-control"
(cd shell/island && find . -type f ! -name '*.ts' ! -name tsconfig.json ! -name gschemas.compiled ! -path './build/*' -print0 | cpio -0pdm "$X/island@niro.local" 2>/dev/null)
cp -r shell/island/build/. "$X/island@niro.local/"
mkdir -p "$X/dock@niro.local" "$X/search@niro.local" "$X/emulator@niro.local"
cp -r shell/dock/dist/. "$X/dock@niro.local/"; cp shell/dock/metadata.json shell/dock/stylesheet.css "$X/dock@niro.local/"; cp -r shell/dock/schemas "$X/dock@niro.local/"
cp shell/search/build/*.js shell/search/metadata.json shell/search/stylesheet.css "$X/search@niro.local/"
for e in blur corners emoji tile; do cp -r "shell/$e" "$X/$e@niro.local"; done
cp shell/emulator/build/extension.js shell/emulator/metadata.json "$X/emulator@niro.local/"
for d in "$X"/*/schemas; do rm -f "$d/gschemas.compiled"; glib-compile-schemas "$d"; done
cp control/org.niro.control.gschema.xml "$P/share/glib-2.0/schemas/"; glib-compile-schemas "$P/share/glib-2.0/schemas"
cp control/build/*.js "$P/share/niro-control/"; mkdir -p "$P/share/niro-control/tile"; cp control/build/tile/*.js "$P/share/niro-control/tile/"; cp -r control/profiles "$P/share/niro-control/"; cp control/gtk3-probe.js "$P/share/niro-control/"
D="${DAEMON:-$PWD/target/release/island-daemon}"
for u in org.niro.island.Daemon.service; do sed "s|@BINDIR@|$(dirname "$D")|" "data/$u" > "$P/share/dbus-1/services/$u"; done
mkdir -p "$P/bin"; printf '#!/bin/sh\nexec gjs -m %s/share/niro-control/niro-control.js "$@"\n' "$P" > "$P/bin/niro-control"; chmod +x "$P/bin/niro-control"
echo "$P"
