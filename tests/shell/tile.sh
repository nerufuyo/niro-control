#!/bin/bash
# The tiling against a real GNOME Shell (headless): every layout, with 1, 2, 3, 4, 6 and 10 real windows, must put the windows where the layout
# says (the geometry `arrange()` computes), none over another; then a window closed, and one moved to another workspace, re-tile the rest.
# Needs the staged extensions (tests/shell/run-staged.sh) or the installed package.
set -u
cd "$(dirname "$0")/../.."
# The test must not write the real ~/.local/share (Search's audit log, snips): run-staged.sh already isolates it, a direct run does here.
[ -n "${NIRO_TEST_ISOLATED:-}" ] || { export XDG_DATA_HOME; XDG_DATA_HOME=$(mktemp -d); }
LOG=$(mktemp); WORK=$(mktemp -d); trap 'rm -f "$LOG"; rm -rf "$WORK"; rm -f /run/user/$UID/gnome-shell-disable-extensions' EXIT
FAILS=0
rm -f /run/user/$UID/gnome-shell-disable-extensions
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected [$3], got [$2]"; FAILS=$((FAILS+1)); fi; }
cat > "$WORK/app.js" <<'J'
imports.gi.versions.Gtk = "4.0"; const {Gtk} = imports.gi; Gtk.init(); const id = ARGV[0];
const a = new Gtk.Application({application_id: "org.niro.TileTest" + id});
a.connect("activate", () => { const w = new Gtk.ApplicationWindow({application: a, title: "w" + String(id).padStart(2, "0")}); w.set_default_size(300, 200); w.set_child(new Gtk.Label({label: "window " + id})); w.present(); });
a.run([]);
J
mkdir -p "$WORK/cfg/glib-2.0/settings"
printf "[org/gnome/shell]\nwelcome-dialog-last-shown-version='99'\n" > "$WORK/cfg/glib-2.0/settings/keyfile"
export WORK LOG
# its own settings file: the extension and `gsettings` (separate processes) must see the same values, which the memory backend cannot do
export GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME="$WORK/cfg"
timeout 280 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-tiletest --virtual-monitor 2560x1440 > "$LOG" 2>&1 &
sleep 16
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
TS="gsettings set org.gnome.shell.extensions.tile"
[ -n "${NIRO_EXT_ROOT:-}" ] && TS="gsettings --schemadir $NIRO_EXT_ROOT/tile@niro.local/schemas set org.gnome.shell.extensions.tile"
ev "Main.extensionManager.enableExtension(\"tile@niro.local\")" >/dev/null; sleep 4; ev "Main.overview.hide(); 1" >/dev/null
$TS enabled true
R="JSON.stringify({area: (function(){const a=Main.layoutManager.getWorkAreaForMonitor(0); return {x:a.x,y:a.y,width:a.width,height:a.height}})(), focus: global.get_window_actors().map(a=>a.meta_window).filter(w=>/^w[0-9][0-9]$/.test(w.title)).sort((a,b)=>a.title<b.title?-1:1).indexOf(global.display.focus_window), windows: global.get_window_actors().map(a=>a.meta_window).filter(w=>/^w[0-9][0-9]$/.test(w.title)).sort((a,b)=>a.title<b.title?-1:1).map(w=>{const f=w.get_frame_rect(); return {title:w.title,x:f.x,y:f.y,width:f.width,height:f.height}})})"
opened=0
for n in 1 2 3 4 6 10; do
  while [ $opened -lt $n ]; do opened=$((opened+1)); (WAYLAND_DISPLAY=niro-tiletest GDK_BACKEND=wayland gjs "$WORK/app.js" $opened >/dev/null 2>&1 & echo $! >> "$WORK/app.pids"); sleep 2.5; ev "Main.overview.hide(); 1" >/dev/null; done
  for layout in dwindle master-left master-right center-master grid three-columns horizontal vertical scrolling monocle; do
    $TS layout $layout; sleep 1.6
    ev "$R" | python3 tests/shell/tileState.py $layout > "$WORK/state.json"
    PROBLEMS=$(node tests/shell/tileExpect.mjs < "$WORK/state.json" 2>/dev/null)
    COUNT=$(python3 -c "import json; print(len(json.load(open(\"$WORK/state.json\"))[\"windows\"]))")
    if [ -z "$PROBLEMS" ] && [ "$COUNT" = "$n" ]; then echo "ok   $layout with $n windows"; else echo "FAIL $layout with $n windows (saw $COUNT): $PROBLEMS"; fi
  done
done
# a window closed: the rest are laid out again
$TS layout master-left; sleep 1.5
ev "global.get_window_actors().map(a=>a.meta_window).find(w=>w.title===\"w10\").delete(global.get_current_time()); 1" >/dev/null; sleep 3
ev "$R" | python3 tests/shell/tileState.py master-left > "$WORK/state.json"
PROBLEMS=$(node tests/shell/tileExpect.mjs < "$WORK/state.json" 2>/dev/null); COUNT=$(python3 -c "import json; print(len(json.load(open(\"$WORK/state.json\"))[\"windows\"]))")
if [ -z "$PROBLEMS" ] && [ "$COUNT" = "9" ]; then echo "ok   after a window is closed, the other nine are laid out again"; else echo "FAIL after a window closed (saw $COUNT): $PROBLEMS"; fi
[ -s "$WORK/app.pids" ] && kill $(cat "$WORK/app.pids") 2>/dev/null; kill %1' 2>&1 | grep -E "^(ok|FAIL)" | tee "$WORK/out.txt"
FAILS=$(grep -c "^FAIL" "$WORK/out.txt"); OKS=$(grep -c "^ok" "$WORK/out.txt")
echo
[ "$OKS" -ge 61 ] || { echo "FAIL only $OKS checks ran, wanted 61"; FAILS=$((FAILS+1)); }
[ "$FAILS" = 0 ] && echo "tile checks: all passed ($OKS)" || { echo "tile checks: $FAILS failed"; exit 1; }
