#!/bin/bash
# Screenshots of real GTK 4 / libadwaita applications (Files, Text Editor, Settings) with the GTK theme integration installed in a
# throw-away config folder, over a detailed wallpaper, dark and light, in a private headless shell: a check of the adapter, not of your session.
set -u
cd "$(dirname "$0")/.."
OUT=$(readlink -f "${1:-reports/ui/gtk}"); mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
CLOUDS=/usr/share/backgrounds/Clouds_by_Tibor_Mokanszki.jpg
mkdir -p "$WORK/home"
cat > "$WORK/install.js" <<'J'
import GLib from 'gi://GLib';
import {install} from 'file:///home/nerufuyo/projects/niro-control/control/build/gtkAdapter.js';
const [cfg, backups, scheme] = ARGV;
install({configDir: cfg, backupRoot: backups, consent: true, scheme, glass: 80, tint: '#1C1C1E', surfaces: {sidebar: 70, content: 85, elevated: 92}});
J
export WORK OUT CLOUDS
timeout 500 dbus-run-session -- env GSETTINGS_BACKEND=memory bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-gtk --virtual-monitor 1440x900 > /dev/null 2>&1 & SP=$!
sleep 22
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" > /dev/null 2>&1; }
ev "Main.overview.hide(); global.__bg = new imports.gi.St.Widget({style: \"background-image:url(file://$CLOUDS);background-size:1440px 900px\", width:1440, height:900}); Main.layoutManager._backgroundGroup.add_child(global.__bg); 1"
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" > /dev/null 2>&1; }
run() { # name scheme integration command...
  local name=$1 scheme=$2 integ=$3; shift 3
  local cfg="$WORK/cfg-$scheme-$integ"; mkdir -p "$cfg"
  [ "$integ" = on ] && gjs -m "$WORK/install.js" "$cfg" "$WORK/backups-$scheme" "$scheme" > /dev/null 2>&1
  local theme=""; { [ "$name" = gtk3 ] || [ "$name" = terminal ]; } && [ "$scheme" = dark ] && theme="GTK_THEME=Adwaita:dark"   # GTK 3 follows its theme
  env XDG_CONFIG_HOME="$cfg" WAYLAND_DISPLAY=niro-gtk GDK_BACKEND=wayland ADW_DEBUG_COLOR_SCHEME=prefer-$scheme $theme "$@" > /dev/null 2>&1 & local P=$!
  sleep 9; ev "Main.overview.hide(); 1"; sleep 1; shot "$name-$scheme-$integ"; kill $P 2>/dev/null; wait $P 2>/dev/null; sleep 1
}
GTK3="imports.gi.versions.Gtk=\"3.0\"; const {Gtk}=imports.gi; Gtk.init(null); const w=new Gtk.Window({title:\"GTK 3 test\", default_width: 700, default_height: 420}); const hb=new Gtk.HeaderBar({title:\"GTK 3 test\", show_close_button:true}); w.set_titlebar(hb); const box=new Gtk.Box(); const side=new Gtk.ListBox(); side.get_style_context().add_class(\"sidebar\"); for (const t of [\"Documents\",\"Music\",\"Pictures\"]) side.add(new Gtk.Label({label:t, margin:10})); const tv=new Gtk.TextView({hexpand:true}); tv.get_buffer().set_text(\"GTK 3 content: readable text over the glass.\\nSecond line.\", -1); box.pack_start(side,false,false,0); box.pack_start(tv,true,true,0); w.add(box); w.connect(\"destroy\", Gtk.main_quit); w.show_all(); Gtk.main();"
for scheme in dark light; do
  for integ in off on; do
    [ "$integ" = off ] && [ "$scheme" = light ] && continue
    if [ -z "${ONLY:-}" ] || [ "$ONLY" = gtk4 ]; then
      run files $scheme $integ nautilus --new-window /usr/share/backgrounds
      run editor $scheme $integ gnome-text-editor /etc/os-release
      run settings $scheme $integ gnome-control-center
    fi
    if [ -z "${ONLY:-}" ] || [ "$ONLY" = gtk3 ]; then
      run gtk3 $scheme $integ gjs -c "$GTK3"
      run terminal $scheme $integ gnome-terminal
    fi
  done
done
kill $SP' > /dev/null 2>&1
ls "$OUT"
