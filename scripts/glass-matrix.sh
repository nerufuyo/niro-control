#!/bin/bash
# Screenshots of the control panel over different wallpapers, opacities and schemes, in a private headless GNOME Shell, to judge the
# glass and the readability by eye. Output: $1 (default reports/ui/after). Nothing of your session or settings is touched: the panel
# runs on a throw-away settings backend, and the shell reads (never writes) your settings.
#   NEW_BLUR=1 (default)  load the blur extension from this repository instead of the installed one (the panel's own-glass rule)
set -u
cd "$(dirname "$0")/.."
OUT=$(readlink -f "${1:-reports/ui/after}"); mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
SCHEMAS="$WORK/schemas"; mkdir "$SCHEMAS"
for d in control shell/island/schemas shell/dock/schemas shell/blur/schemas shell/corners/schemas; do cp $d/*.gschema.xml "$SCHEMAS/"; done
glib-compile-schemas "$SCHEMAS"
python3 - "$WORK/checker.png" <<'P'
import sys, zlib, struct
W = H = 64; cell = 8
raw = b''.join(b'\x00' + b''.join(bytes([255 if (x // cell + y // cell) % 2 else 0] * 3) for x in range(W)) for y in range(H))
def ch(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))
P
# a user data dir that is yours plus (optionally) the repository's blur extension
SHARE="$WORK/share"; mkdir -p "$SHARE/gnome-shell/extensions"
for e in "$HOME"/.local/share/*; do [ "$(basename "$e")" = gnome-shell ] || ln -s "$e" "$SHARE/$(basename "$e")"; done
if [ "${NEW_BLUR:-1}" = 1 ]; then
  cp -r /usr/share/gnome-shell/extensions/blur@niro.local "$SHARE/gnome-shell/extensions/"
  chmod -R u+w "$SHARE/gnome-shell/extensions/blur@niro.local"
  cp shell/blur/components/applications/index.js "$SHARE/gnome-shell/extensions/blur@niro.local/components/applications/index.js"
fi
CLOUDS=/usr/share/backgrounds/Clouds_by_Tibor_Mokanszki.jpg
# name|css of the wallpaper actor
WALLS=("dark|background-color:#0b0b10" "bright|background-color:#f6f4ee" "detailed|background-image:url('file://$CLOUDS');background-size:1440px 900px" "contrast|background-image:url('file://$WORK/checker.png');background-size:1440px 900px")
# scheme:opacity:wallpaper
CASES=(${CASES_OVERRIDE:-dark:20:dark dark:80:dark dark:100:dark dark:20:bright dark:80:bright dark:20:detailed dark:80:detailed dark:20:contrast dark:80:contrast light:20:bright light:80:bright light:100:bright light:20:dark light:80:detailed light:20:contrast})
export OUT WORK SCHEMAS CLOUDS; export WALLS_JOINED="$(printf '%s\n' "${WALLS[@]}")"; export CASES_JOINED="${CASES[*]}"
timeout 600 dbus-run-session -- env XDG_DATA_HOME="$SHARE" bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-glass --virtual-monitor 1440x900 > /dev/null 2>&1 & SP=$!
sleep 25
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" > /dev/null 2>&1; }
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" > /dev/null 2>&1; }
for c in $CASES_JOINED; do
  IFS=: read scheme opacity wall <<< "$c"
  css=$(echo "$WALLS_JOINED" | grep "^$wall|" | cut -d"|" -f2-)
  ev "if (global.__bg) global.__bg.destroy(); global.__bg = new imports.gi.St.Widget({style: \"$css\", width: 1440, height: 900}); Main.layoutManager._backgroundGroup.add_child(global.__bg); 1"
  env GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$SCHEMAS" NIRO_SCHEMA_DIR="$SCHEMAS" NIRO_CONFIG_DIR="$WORK/cfg" WAYLAND_DISPLAY=niro-glass GDK_BACKEND=wayland \
    NIRO_NOBANNER=1 NIRO_SIZE=1100x700 NIRO_PAGE=${NIRO_PAGE:-look} NIRO_SCHEME=$scheme NIRO_SET_OPACITY=$opacity gjs -m scripts/screenshot-panel.js > /dev/null 2>&1 & P=$!
  sleep 5; ev "Main.overview.hide()"; sleep 1; shot "$scheme-$opacity-$wall"; kill $P 2>/dev/null; wait $P 2>/dev/null
done
kill $SP' > /dev/null 2>&1
ls "$OUT"
