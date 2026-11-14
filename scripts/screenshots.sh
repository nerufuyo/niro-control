#!/bin/bash
# Regenerates the README screenshots in docs/images from a private headless GNOME Shell (the installed package, your look settings,
# nothing of your session is touched). Needs the installed package and a built control panel (npm run build).
set -u
cd "$(dirname "$0")/.."
OUT=$PWD/docs/images; mkdir -p "$OUT"
timeout 300 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-shots --virtual-monitor 1440x900 > /dev/null 2>&1 & SP=$!
sleep 25
ev "Main.overview.hide()"; sleep 2
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" > /dev/null 2>&1; }
shot() { ev "Main.overview.hide()"; sleep 1; gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "'"$OUT"'/$1.png" >/dev/null 2>&1; }
for page in home profiles look island dock; do export NIRO_PAGE=$page;
  WAYLAND_DISPLAY=niro-shots GDK_BACKEND=wayland NIRO_NOBANNER=1 NIRO_SIZE=1100x700 gjs -m scripts/screenshot-panel.js > /dev/null 2>&1 & P=$!
  sleep 5; shot panel-$page; kill $P 2>/dev/null; wait $P 2>/dev/null
done
O="Main.extensionManager.lookup(\"search@niro.local\").stateObj"
for q in "dock position" "2*pi+17" "profile"; do case "$q" in dock*) n=settings;; 2*) n=calculator;; *) n=profiles;; esac
  WAYLAND_DISPLAY=niro-shots GDK_BACKEND=wayland NIRO_NOBANNER=1 NIRO_PAGE=home NIRO_SIZE=1100x700 gjs -m scripts/screenshot-panel.js > /dev/null 2>&1 & P=$!
  sleep 5; ev "$O._open(); $O._entry.set_text(\"$q\"); 1"; sleep 1; shot "search-$n"; ev "$O._close(); 1"; kill $P 2>/dev/null; wait $P 2>/dev/null
done
exit 0' > /dev/null 2>&1
echo done
