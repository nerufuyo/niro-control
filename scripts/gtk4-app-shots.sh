#!/bin/bash
# The libadwaita test window (sidebar, entry, switch rows, text view, popover menu, dialog) with and without the GTK adapter, dark and
# light, one private headless shell per picture (a shell shared between pictures dies when a client with an open popover is killed).
set -u
cd "$(dirname "$0")/.."
OUT=$(readlink -f "${1:-reports/ui/gtk}"); mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/install.js" <<J
import {install} from 'file://$PWD/control/build/gtkAdapter.js';
const [cfg, backups, scheme] = ARGV;
install({configDir: cfg, backupRoot: backups, consent: true, scheme, glass: 80, tint: '#1C1C1E', surfaces: {sidebar: 70, content: 85, elevated: 92}});
J
one() { # state scheme integ
  local state=$1 scheme=$2 integ=$3 cfg="$WORK/cfg-$2-$3"; mkdir -p "$cfg"
  [ "$integ" = on ] && gjs -m "$WORK/install.js" "$cfg" "$WORK/backups-$scheme" "$scheme" > /dev/null 2>&1
  timeout 90 dbus-run-session -- env GSETTINGS_BACKEND=memory bash -c '
  gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-g4 --virtual-monitor 1440x900 > /dev/null 2>&1 & SP=$!
  sleep 18
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "Main.overview.hide(); global.__bg = new imports.gi.St.Widget({style: \"background-image:url(file:///usr/share/backgrounds/Clouds_by_Tibor_Mokanszki.jpg);background-size:1440px 900px\", width:1440, height:900}); Main.layoutManager._backgroundGroup.add_child(global.__bg); 1" > /dev/null 2>&1
  (env XDG_CONFIG_HOME="'"$cfg"'" WAYLAND_DISPLAY=niro-g4 GDK_BACKEND=wayland ADW_DEBUG_COLOR_SCHEME=prefer-'"$scheme"' TEST_STATE='"$state"' gjs -m scripts/gtk4-test-app.js > /dev/null 2>&1 &)
  sleep 9
  gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "'"$OUT"'/app-'"$state"'-'"$scheme"'-'"$integ"'.png" > /dev/null 2>&1
  kill $SP' > /dev/null 2>&1
}
for state in popover dialog; do one $state dark off; one $state dark on; one $state light on; done
ls "$OUT" | grep '^app-'
