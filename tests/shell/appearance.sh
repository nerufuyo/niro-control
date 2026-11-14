#!/bin/bash
# The blur extension's per-application rules against a real GNOME Shell (headless, its own settings in memory, the repository's
# blur extension instead of the installed one): by default a window is blurred and not faded; an excluded one is neither; a fade
# happens only when the rule asks for it and the global allowance is on; safe mode and the global switch end every effect.
set -u
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
SHARE="$WORK/share"; mkdir -p "$SHARE/gnome-shell/extensions"
for e in "$HOME"/.local/share/*; do [ "$(basename "$e")" = gnome-shell ] || ln -s "$e" "$SHARE/$(basename "$e")"; done
cp -r /usr/share/gnome-shell/extensions/blur@niro.local "$SHARE/gnome-shell/extensions/"; chmod -R u+w "$SHARE/gnome-shell/extensions/blur@niro.local"
cp shell/blur/components/applications/index.js "$SHARE/gnome-shell/extensions/blur@niro.local/components/applications/index.js"
SCHEMAS="$WORK/schemas"; mkdir "$SCHEMAS"; cp control/org.niro.control.gschema.xml "$SCHEMAS/"; glib-compile-schemas "$SCHEMAS"   # the repository's schema, not the installed one
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; FAILS=$((FAILS+1)); fi; }
OUT="$WORK/out.txt"
timeout 200 dbus-run-session -- env XDG_DATA_HOME="$SHARE" GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$SCHEMAS" bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-app --virtual-monitor 1280x720 > '"$WORK"'/shell.log 2>&1 & SP=$!
sleep 20
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
ev "Main.extensionManager.enableExtension(\"blur@niro.local\"); 1" > /dev/null; sleep 4
ev "(function(){ const G=imports.gi.Gio; const src=G.SettingsSchemaSource.new_from_directory(\"'"$SHARE"'/gnome-shell/extensions/blur@niro.local/schemas\", G.SettingsSchemaSource.get_default(), false); const s=new G.Settings({settings_schema: src.lookup(\"org.gnome.shell.extensions.blur-my-shell.applications\", false)}); s.set_boolean(\"blur\", true); s.set_boolean(\"enable-all\", true); s.set_strv(\"blacklist\", []); s.set_boolean(\"dynamic-opacity\", false); return 1; })()" > /dev/null; sleep 3
echo "STATE $(gnome-extensions info blur@niro.local 2>&1 | grep State | tr -d " ")" > '"$OUT"'
APP="imports.gi.versions.Gtk=\"4.0\"; const {Gtk,GLib}=imports.gi; Gtk.init(); const a=new Gtk.Application({application_id: ARGV[0]}); a.connect(\"activate\",()=>{ new Gtk.ApplicationWindow({application:a, title: ARGV[0]}).present(); }); a.run([]);"
for id in org.niro.TestA org.niro.TestB org.niro.TestC; do (WAYLAND_DISPLAY=niro-app GDK_BACKEND=wayland gjs -c "$APP" $id >/dev/null 2>&1 & echo $! >> '"$WORK"'/pids); sleep 3; done; sleep 3; ev "Main.overview.hide(); 1" > /dev/null; sleep 2
# per window: [blur actor shown, child opacity of the window actor]
probe() { ev "(function(){ const r=[]; for (const a of global.get_window_actors()) { const w=a.meta_window; const b=w.blur_actor; r.push(w.get_wm_class()+\"=\"+(b ? b.visible : \"none\")+\"/\"+Math.max(...a.get_children().filter(c=>c!==b&&c.name!==\"bms-application-blurred-widget\").map(c=>c.opacity))); } return r.sort().join(\" \"); })()" | grep -o "org.niro[^\"]*" ; }
echo "DEFAULT $(probe)" >> '"$OUT"'
N="new imports.gi.Gio.Settings({schema_id:\"org.niro.control\"})"
ev "$N.set_string(\"app-rules\", JSON.stringify({\"org.niro.TestB\":{mode:\"exclude\"},\"org.niro.TestC\":{mode:\"fade\",opacity:50}})); 1" > /dev/null; sleep 1
echo "RULES_NO_ALLOWANCE $(probe)" >> '"$OUT"'
ev "$N.set_boolean(\"affect-thirdparty\", true); 1" > /dev/null; sleep 1
echo "RULES_ALLOWED $(probe)" >> '"$OUT"'
ev "$N.set_boolean(\"safe-mode\", true); 1" > /dev/null; sleep 1
echo "SAFE $(probe)" >> '"$OUT"'
ev "$N.set_boolean(\"safe-mode\", false); $N.set_boolean(\"universal-enabled\", false); 1" > /dev/null; sleep 1
echo "OFF $(probe)" >> '"$OUT"'
kill $(cat '"$WORK"'/pids) 2>/dev/null; kill $SP' > /dev/null 2>&1
cat "$OUT"; grep -iE "JS ERROR|blur" "$WORK/shell.log" | grep -v "^dbus" | head -8
has() { if grep -q "$2" "$OUT"; then echo "ok   $1"; else echo "FAIL $1 (wanted: $2)"; FAILS=$((FAILS+1)); fi; }
has "blur extension active" "State:ACTIVE"
has "default: every window blurred, none faded" "DEFAULT org.niro.TestA=true/255 org.niro.TestB=true/255 org.niro.TestC=true/255"
has "an excluded window is not blurred; a fade needs the allowance" "RULES_NO_ALLOWANCE org.niro.TestA=true/255 org.niro.TestB=false/255 org.niro.TestC=true/255"
has "with the allowance only the rule's window fades" "RULES_ALLOWED org.niro.TestA=true/255 org.niro.TestB=false/255 org.niro.TestC=true/127"
has "safe mode: no blur, no fade" "SAFE org.niro.TestA=false/255 org.niro.TestB=false/255 org.niro.TestC=false/255"
has "global switch off: no effect on any window" "OFF org.niro.TestA=false/255 org.niro.TestB=false/255 org.niro.TestC=false/255"
[ $FAILS = 0 ] && echo "appearance shell checks: all passed" || echo "appearance shell checks: $FAILS failed"
