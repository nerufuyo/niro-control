#!/bin/bash
# A hermetic headless GNOME Shell with only the dock enabled, for runtime checks of the dock's motion and lifecycle.
# Own XDG_RUNTIME_DIR, HOME, XDG dirs, D-Bus session, key-file settings backend and wayland socket: it never touches the real session
# and other headless shells can run beside it. The dock under test is read from a built directory (tsc output plus metadata,
# stylesheet and schemas), so the same script runs a baseline build and a branch build.
#   usage: dock-session.sh <built-dock-dir> <steps-script> <outdir> [env: MONITORS="1920x1080" SCALE=1]
# The steps script is sourced with ev, shot, wait_ms, M (virtual pointer move), and $WORK, $OUT defined. Prints the shell log tail at the end.
set -u
DOCK=$(readlink -f "$1"); STEPS=$(readlink -f "$2"); OUT=$(readlink -f "$3"); mkdir -p "$OUT"
export DOCK STEPS OUT
WORK=$(mktemp -d); export WORK; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"/{config,cache,home,data,run}; chmod 700 "$WORK/run"
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_RUNTIME_DIR="$WORK/run" GSETTINGS_BACKEND=keyfile
EXT="$XDG_DATA_HOME/gnome-shell/extensions/dock@niro.local"; mkdir -p "$EXT"
cp -r "$DOCK"/dist/. "$EXT/"; cp "$DOCK/metadata.json" "$DOCK/stylesheet.css" "$EXT/"; cp -r "$DOCK/schemas" "$EXT/"
rm -f "$EXT/schemas/gschemas.compiled"; glib-compile-schemas "$EXT/schemas"
HERE=$(cd "$(dirname "$0")" && pwd); mkdir -p "$EXT/shared"; cp "$HERE/../../shell/shared/motionEngine.js" "$EXT/shared/" 2>/dev/null
MON=${MONITORS:-1920x1080}; VM=""; for m in $MON; do VM="$VM --virtual-monitor $m"; done
export VM
timeout 900 dbus-run-session -- bash -c '
gsettings set org.gnome.shell welcome-dialog-last-shown-version "'"'"'99.0'"'"'"
gsettings set org.gnome.shell enabled-extensions "['"'"'dock@niro.local'"'"']"
gsettings set org.gnome.shell favorite-apps "['"'"'org.gnome.Calculator.desktop'"'"', '"'"'org.gnome.Nautilus.desktop'"'"', '"'"'org.gnome.TextEditor.desktop'"'"', '"'"'org.gnome.Settings.desktop'"'"', '"'"'org.gnome.Terminal.desktop'"'"']"
gnome-shell --headless --wayland --no-x11 --unsafe-mode --wayland-display=niro-dock-$$ $VM > "$WORK/shell.log" 2>&1 & SP=$!
sleep 14
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1" 2>&1 | sed -E "s/^\((true|false), ?\x27?//; s/\x27?\)\$//; s/^\"//; s/\"\$//; s/\\\\\\\\\"/\"/g"; }
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$OUT/$1.png" > /dev/null 2>&1; }
wait_ms() { sleep $(awk "BEGIN{print $1/1000}"); }
M() { ev "global.__move($1, $2); 1" > /dev/null; }
export -f ev shot wait_ms M
export WAYLAND_DISPLAY=niro-dock-'$$'
ev "(function(){ const C = imports.gi.Clutter, G = imports.gi.GLib; global.__ptr = (C.get_default_backend ? C.get_default_backend() : global.stage.context.get_backend()).get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); global.__move = (x, y) => global.__ptr.notify_absolute_motion(G.get_monotonic_time(), x, y); return 1; })()" > /dev/null
source "$STEPS"
kill $SP; wait $SP 2>/dev/null' "$@" 2>&1 | grep -vE "Gtk-WARNING|portal|dbus-daemon|goa-|evolution|fusermount|fuse|keyring|SSH_AUTH|discover_other|^$"
cp "$WORK/shell.log" "$OUT/shell.log" 2>/dev/null
