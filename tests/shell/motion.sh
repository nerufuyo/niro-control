#!/bin/bash
# The island's motion in a real GNOME Shell (headless): its size, position and opacity every frame while it opens, changes
# page, is interrupted and closes, then judged by tests/shell/motion.py: no jump from one frame to the next beyond what a spring
# does, no shaking once at rest, no overshoot past a few percent, no page that blinks. Run through
# tests/shell/run-staged.sh (`run-staged.sh motion`). With NIRO_MOTION=<file> it keeps the raw frames as JSON.
set -u
cd "$(dirname "$0")/../.."
export GSETTINGS_BACKEND=${GSETTINGS_BACKEND:-memory}
LOG=$(mktemp); RAW=${NIRO_MOTION:-$(mktemp)}; trap 'rm -f "$LOG"' EXIT
timeout 200 dbus-run-session -- bash -c '
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-motion --virtual-monitor 1440x900 > '"$LOG"' 2>&1 & SP=$!
sleep 22
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "Main.extensionManager.enableExtension(\"island@niro.local\")" >/dev/null 2>&1; sleep 12
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1; }
C="Main.extensionManager.lookup(\"island@niro.local\").stateObj._controller"
# The recorder: one row a frame, [ms, width, height, x, y, opacity, label, [what the island holds: id, visible, opacity, y shift, x, width]].
ev "(function(){ const Clutter = imports.gi.Clutter, GLib = imports.gi.GLib; const isl = $C._island; globalThis.__rec = {rows: [], label: \"start\"};
  const t = new Clutter.Timeline({actor: isl, duration: 1000, repeat_count: -1});
  t.connect(\"new-frame\", () => { const kids = []; isl._views.forEach((c, i) => kids.push([\"view\" + i + c.constructor.name, c.visible ? 1 : 0, c.opacity, c.translation_y, c.x, c.width]));
    __rec.rows.push([GLib.get_monotonic_time() / 1000, isl.width, isl.height, isl.x, isl.y, isl.opacity, __rec.label, kids]); });
  t.start(); globalThis.__recTimeline = t; return 1; })()" >/dev/null
label() { ev "__rec.label = \"$1\"; 1" >/dev/null; }
EXPANDED="$C._expanded"
sleep 2
label open_music;   ev "$C.expand(\"music\"); 1" >/dev/null; sleep 2.5
label page_notifications; ev "$EXPANDED.showPage(\"notifications\"); 1" >/dev/null; sleep 2
label page_calendar; ev "$EXPANDED.showPage(\"calendar\"); 1" >/dev/null; sleep 2
label page_apps;    ev "$EXPANDED.showPage(\"apps\"); 1" >/dev/null; sleep 2
label page_music;   ev "$EXPANDED.showPage(\"music\"); 1" >/dev/null; sleep 2
label page_rapid;   for p in notifications calendar music shelf apps; do ev "$EXPANDED.showPage(\"$p\"); 1" >/dev/null; sleep 0.12; done; sleep 2
label close;        ev "$C.collapse(); 1" >/dev/null; sleep 2.5
label reopen_interrupt; ev "$C.expand(\"calendar\"); 1" >/dev/null; sleep 0.18; ev "$C.collapse(); 1" >/dev/null; sleep 2.5
label open_close_open; ev "$C.expand(\"music\"); 1" >/dev/null; sleep 0.25; ev "$C.collapse(); 1" >/dev/null; sleep 0.25; ev "$C.expand(\"shelf\"); 1" >/dev/null; sleep 2.5
label final_close;  ev "$C.collapse(); 1" >/dev/null; sleep 2.5
ev "imports.gi.GLib.file_set_contents(\"'"$RAW"'\", JSON.stringify(__rec.rows)); __recTimeline.stop(); 1" >/dev/null
echo "ERRORS $(grep -c -E "JS ERROR|Gjs-CRITICAL|TypeError|ReferenceError" '"$LOG"')"
kill $SP 2>/dev/null' 2>&1 | grep -E "^ERRORS"
python3 tests/shell/motion.py "$RAW"
