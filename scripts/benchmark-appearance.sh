#!/bin/bash
# Cost of the window effects, in private headless shells with six GTK 4 windows open and the blur extension running:
#   legacy   the installed extension with the old whole-window fade (applications opacity 80%)
#   engine   this repository's extension, per-application rules, no fade by default
#   safe     the same with safe mode on (no blur, no fade)
#   none     no blur extension at all (the floor)
# REPS (default 2) runs of each. Per variant: shell CPU over an idle window, RSS/PSS, and how many frames the shell painted in that window (a static desktop
# should paint nothing). One sample per variant: treat differences under about half a percentage point as noise.
# Not measured: frame timing under animation, GPU load, battery, several monitors, video, screen sharing.
set -u
cd "$(dirname "$0")/.."
WINDOW=${WINDOW:-25}; N=${N:-6}
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
SHARE="$WORK/share"; mkdir -p "$SHARE/gnome-shell/extensions"
for e in "$HOME"/.local/share/*; do [ "$(basename "$e")" = gnome-shell ] || ln -s "$e" "$SHARE/$(basename "$e")"; done
cp -r /usr/share/gnome-shell/extensions/blur@niro.local "$SHARE/gnome-shell/extensions/"; chmod -R u+w "$SHARE/gnome-shell/extensions/blur@niro.local"
cp shell/blur/components/applications/index.js "$SHARE/gnome-shell/extensions/blur@niro.local/components/applications/index.js"
SCHEMAS="$WORK/schemas"; mkdir "$SCHEMAS"; cp control/org.niro.control.gschema.xml "$SCHEMAS/"; glib-compile-schemas "$SCHEMAS"
OUT="$WORK/out.txt"; : > "$OUT"
variant() { # name, use-repo-extension(1/0), blur-ext(1/0), niro-set (js), legacy-opacity
  local name=$1 repo=$2 ext=$3 js=$4
  local data="$HOME/.local/share"; [ "$repo" = 1 ] && data="$SHARE"
  timeout 300 dbus-run-session -- env XDG_DATA_HOME="$data" GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$SCHEMAS" bash -c '
  DISP=niro-bm-'"$name"'-$$; gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=$DISP --virtual-monitor 1280x720 > /dev/null 2>&1 & SP=$!
  sleep 20
  ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
  if [ '"$ext"' = 1 ]; then
    ev "Main.extensionManager.enableExtension(\"blur@niro.local\"); 1" > /dev/null; sleep 4
    ev "(function(){ const G=imports.gi.Gio; const src=G.SettingsSchemaSource.new_from_directory(\"'"$SHARE"'/gnome-shell/extensions/blur@niro.local/schemas\", G.SettingsSchemaSource.get_default(), false); const s=new G.Settings({settings_schema: src.lookup(\"org.gnome.shell.extensions.blur-my-shell.applications\", false)}); s.set_boolean(\"blur\", true); s.set_boolean(\"enable-all\", true); s.set_strv(\"blacklist\", []); s.set_boolean(\"dynamic-opacity\", false); s.set_int(\"opacity\", '"${5:-255}"'); return 1; })()" > /dev/null
  fi
  ev "'"$js"'" > /dev/null
  APP="imports.gi.versions.Gtk=\"4.0\"; const {Gtk,GLib}=imports.gi; Gtk.init(); const a=new Gtk.Application({application_id: ARGV[0]}); a.connect(\"activate\",()=>{ const w=new Gtk.ApplicationWindow({application:a, title: ARGV[0]}); w.set_child(new Gtk.Label({label: ARGV[0]})); w.present(); }); a.run([]);"
  for i in $(seq 1 '"$N"'); do (WAYLAND_DISPLAY=$DISP GDK_BACKEND=wayland gjs -c "$APP" org.niro.Bench$i >/dev/null 2>&1 & echo $! >> '"$WORK"'/pids); sleep 1.5; done
  sleep 3; ev "Main.overview.hide(); 1" > /dev/null; sleep 3
  ev "global.__paints = 0; global.stage.connect(\"after-paint\", () => { global.__paints++; }); 1" > /dev/null
  ticks() { awk "{print \$14+\$15}" /proc/$SP/stat; }
  t=$(ticks); sleep '"$WINDOW"'; d=$(( $(ticks) - t ))
  paints=$(ev "global.__paints" | grep -oE "[0-9]+" | tail -1)
  mem=$(awk "/^(Rss|Pss):/{printf \"%s=%.0f \", \$1, \$2/1024}" /proc/$SP/smaps_rollup)
  echo "'"$name"' cpu_percent=$(awk "BEGIN{printf \"%.2f\", $d/100/'"$WINDOW"'*100}") frames=$paints $mem" >> '"$OUT"'
  kill $(cat '"$WORK"'/pids) 2>/dev/null; rm -f '"$WORK"'/pids; kill $SP' > /dev/null 2>&1
}
for rep in $(seq 1 ${REPS:-2}); do
  variant legacy 0 1 "1" 204
  variant engine 1 1 "1" 255
  variant safe 1 1 "new imports.gi.Gio.Settings({schema_id:\"org.niro.control\"}).set_boolean(\"safe-mode\", true); 1" 255
  variant none 0 0 "1" 255
done
cat "$OUT"
